/**
 * browserSearch.mjs — Chrome 浏览器拟人流搜索通道（webSearch "browser" 引擎的底层实现）。
 *
 * 【功能链】
 *   executeWebSearch(engine="browser") → searchViaBrowserBing(query, config)
 *   → 懒启动 headless Chromium 持久上下文（cookie 常驻 profile）
 *   → 拟人流：必应首页 → 搜索框逐字输入 → 回车 → 等有机结果块 → DOM 提取
 *   → 统一 SearchResult[]（title/url/snippet/source）上行，零命中抛错可见
 *
 * 【why · 2026-07-17 凛倾拍板「联网搜索大更新，以谷歌浏览器为主」】
 *   裸 fetch 刮搜索页对低信任请求会被引擎投毒/降级（0717 实证：冷 GET 中文查询返回
 *   5 条纽约时报、英文查询返回瑞典贷款论坛=填充页；暖 profile 直接 GET 也被查询降级
 *   成首词）。真浏览器拟人流（首页种 cookie + 逐字打字 + 回车）实测 10/10 条高相关。
 *   内容源锚必应：Google 搜索页对本环境出口 IP 直接人机验证墙（/sorry），必应拟人流可通。
 *   引擎失败不做隐式第二引擎兜底（与 webSearch 同口径）：error 原样上行，调用方可见。
 *
 * 【内核发现（不依赖 playwright 版本↔内核 revision 匹配）】
 *   直接 executablePath 启动：按目录扫描候选内核 exe，取 revision 最高者——
 *   优先级 config.browsers_path > <cwd>/browsers（项目根，开源相对路径）> 系统 ms-playwright。
 *   与 crawlProbe.browsersDir 同一优先级语义（那边服务"爬取"能力探测，此处需要精确 exe 路径，
 *   故自扫 exe 而非复用目录级判定）。找不到内核=抛错诚实降级（文案给安装动线），不静默换引擎。
 *
 * 【生命周期】
 *   持久上下文单例懒启动；每次搜索新开 page 用完即关（cookie 留在 profile）；
 *   空闲 120s 自动关浏览器（省内存）；并发搜索经队列串行（单浏览器单 profile）。
 *
 * 【关联链】
 *   ← webSearch.mjs（executeWebSearch "browser" 分派 + resolveBingHref 消费）
 *   → npm:playwright-core（懒 import，失败=通道不可用抛错）
 *   → <cwd>/browsers/search-profile（持久 profile，磁盘写仅此处）
 *
 * 【影响范围】
 *   spawn Chromium 子进程（headless）；写 profile 目录；不写其他磁盘、不广播 WS。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { diag } from "../memory/storage_mod/storage.mjs";

// 版本锚：与本机/自动安装内核兼容的 driver 版本。executablePath 直连使 driver 与内核
// revision 解耦（playwright-core 对 CDP 协议向后兼容窗口宽），此锚只决定 driver 代码版本。
const PLAYWRIGHT_PKG = "npm:playwright-core@1.61.0";

const IDLE_CLOSE_MS = 120000; // 空闲自动关浏览器
const TYPE_DELAY_MS = 25;     // 拟人逐字输入间隔

// 超时接线（用户配置 timeout_ms 单源，storage schema 默认 8000）：浏览器流比裸 fetch 慢
// （启动+渲染），配置值按下限抬升而非照搬——导航 ≥15s、结果等待 ≥8s，配置调大时同步放宽。
function _navTimeout(config) { return Math.max(Number(config?.timeout_ms) || 0, 15000); }
function _resultTimeout(config) { return Math.max(Number(config?.timeout_ms) || 0, 8000); }

// 必应 /ck/a 跳转解码（原 webSearch._resolveBingHref 迁入并导出：browser 与 fetch 两通道
// 共用 bing 域解码，单源防镜像漂移；依赖方向 webSearch → browserSearch 单向无环）。
export function resolveBingHref(rawHref) {
  const href = rawHref.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  if (href.includes("bing.com/ck/a")) {
    try {
      const u = new URL(href).searchParams.get("u");
      if (u) return atob(u.replace(/^a\d+/, ""));
    } catch { /* fall through */ }
  }
  return href;
}

/** DuckDuckGo html 端点跳转解码（/l/?uddg=<urlencoded>）。 */
function _resolveDdgHref(rawHref) {
  try {
    if (rawHref.includes("/l/?") || rawHref.includes("duckduckgo.com/l/")) {
      const u = new URL(rawHref, "https://html.duckduckgo.com").searchParams.get("uddg");
      if (u) return decodeURIComponent(u);
    }
  } catch { /* fall through */ }
  return rawHref;
}

const _HREF_DECODERS = { bing: resolveBingHref, ddg: _resolveDdgHref, none: (h) => h };

// ============================================================
// [0726 Chrome 扩用·002「开始优化」] 内容源注册表
// ============================================================
// why：原 _doSearchBing 把「拟人流骨架」与「必应」焊死——同一套暖 profile+逐字打字+回车的高质量
//   流程只能用一个源，bing 出口漂移时整条 browser 通道即死（0726 凌晨实证：两次搜索连败）。
//   拆分后：骨架通用（打开首页→定位输入框→逐字打字→回车→等结果块→声明式选择器提取→跳转解码），
//   源=纯声明（首页/输入框/结果块/字段选择器/解码器），加源=加一条声明零新分支。
//   ⚠ 这是 browser 引擎【内】的内容源多样化，不是 webSearch 的跨引擎兜底（0717「引擎失败不做
//   隐式第二引擎兜底」仍成立）：每次换源 diag.warn 留痕 + 结果 source 标 "browser:<源>" 上行可见。
// 源可声明两种提交方式：mode="typing"（首页拟人打字流，反爬面最小）| mode="url"（结果页直达，
//   适用于首页输入框在 headless 下不可点/无表单的源）。选择器与解码器均为纯数据声明。
export const BROWSER_SOURCES = {
  // 主源。0717 拍板内容源，0726 实测拟人流 4s/3 条高相关，保持首位。
  bing: {
    label: "必应",
    mode: "typing",
    home: "https://www.bing.com/",
    inputSel: "#sb_form_q, input[name=q]",
    sel: { item: "li.b_algo", title: "h2 a", link: "h2 a", snippet: "p, .b_caption" },
    decode: "bing",
  },
  // 备源（出口友好，0726 实测 /s?wd= 直达 1.3s/10 条，bing 出口漂移时的兜底）。
  //   ⚠ 三条实测事实决定了这三个字段：①首页 #kw 在 headless 下 click 超时（元素存在但不可交互）
  //   → mode="url" 直达 ②摘要类名是构建期混淆的动态类（content-gap_3jlQr / summary-text_15QGa…）
  //   不可作稳定选择器 → snippetFromText 用条目 innerText 去标题兜底 ③链接是 /link?url= 302 跳转
  //   → resolveRedirect 提取后并发解析真实 URL（否则全部结果域名=baidu.com，会被 domain_cap 砍剩 2 条）。
  baidu: {
    label: "百度",
    mode: "url",
    queryUrl: (q) => "https://www.baidu.com/s?wd=" + encodeURIComponent(q),
    sel: { item: "div.result, div.c-container", title: "h3 a", link: "h3 a", snippet: ".c-abstract, .content-right_8Zs40, .c-span-last" },
    snippetFromText: true,
    resolveRedirect: true,
    decode: "none",
  },
  // 声明保留但**默认不启用**：0726 本机实测三端点全部拒服务——html/ 返回错误页、lite/ 要过 bot
  //   验证挑战、主站报 Unexpected error（DDG 对 headless 指纹敏感）。代理/指纹环境不同的用户可
  //   在 browser_sources 显式加 "ddg" 试用；实测不通时会按序降级到下一源，不影响主链。
  ddg: {
    label: "DuckDuckGo(HTML)",
    mode: "url",
    queryUrl: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q),
    sel: { item: ".result__body, .web-result", title: ".result__a", link: ".result__a", snippet: ".result__snippet" },
    decode: "ddg",
  },
};

/**
 * 结果提取表达式（源声明 → 页内 JS 表达式字符串）。
 *
 * 【why 是"生成字符串"而不是内联函数·0726 user_browser 通道接入】
 *   同一套"按源声明的选择器把结果块抽成 {title,href,snippet}"逻辑现在有两个执行环境：
 *   ① headless 通道走 playwright `page.evaluate(fn, args)`；② 用户浏览器通道走 CDP driver 的
 *   `evaluate(exprString)`——后者只接受表达式字符串，传不了函数+参数。
 *   若各写一份，源注册表改一次选择器就要同步改两处提取代码（必漏其一）。抽成"生成表达式"后
 *   两个环境共用同一份提取语义，源声明仍是唯一真相。
 * @param {object} sel - 源声明的选择器组 {item,title,link,snippet}
 * @param {boolean} fromText - 是否启用 innerText 摘要兜底（源声明 snippetFromText）
 * @returns {string} 可直接求值的 JS 表达式，求值结果为 Array<{title,href,snippet}>
 */
export function buildResultExtractExpr(sel, fromText) {
  const S = JSON.stringify(sel);
  const F = fromText ? "true" : "false";
  return `(() => {
  const sel = ${S}, fromText = ${F};
  const out = [];
  for (const it of document.querySelectorAll(sel.item)) {
    const a = it.querySelector(sel.link);
    if (!a || !a.href) continue;
    const t = it.querySelector(sel.title) || a;
    const title = (t.textContent || '').trim();
    let snippet = (it.querySelector(sel.snippet) ? it.querySelector(sel.snippet).textContent : '') || '';
    snippet = snippet.trim();
    if (!snippet && fromText) {
      const full = (it.innerText || '').replace(/\\s+/g, ' ').trim();
      snippet = full.indexOf(title) === 0 ? full.slice(title.length).trim() : full;
    }
    out.push({ title: title, href: a.href, snippet: snippet });
  }
  return out;
})()`;
}

/** 生效源顺序：config.browser_sources ← 默认 ["bing","baidu"]；过滤未知源；全空回退 ["bing"]。 */
function _sourceOrder(config) {
  const raw = Array.isArray(config?.browser_sources) ? config.browser_sources : ["bing", "baidu"];
  const ok = raw.map((s) => String(s || "").trim().toLowerCase()).filter((s) => BROWSER_SOURCES[s]);
  return ok.length > 0 ? ok : ["bing"];
}

// ============================================================
// 内核发现（executablePath 直连）
// ============================================================

// 内核目录内已知 exe 相对路径形态（playwright 官方布局，按平台）
const _EXE_CANDIDATES = process.platform === "win32" ? [
  ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
  ["chrome-win", "headless_shell.exe"],
  ["chrome-win", "chrome.exe"],
] : process.platform === "darwin" ? [
  ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-mac-x64", "Chromium.app", "Contents", "MacOS", "Chromium"],
] : [
  ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  ["chrome-linux", "headless_shell"],
  ["chrome-linux", "chrome"],
];

function _scanKernelDir(dir) {
  try {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir).filter((n) => /^chromium[-_]/i.test(n));
    // revision 最高优先（chromium_headless_shell-1228 > chromium-1208）
    entries.sort((a, b) => (parseInt(b.match(/(\d+)$/)?.[1] || "0", 10)) - (parseInt(a.match(/(\d+)$/)?.[1] || "0", 10)));
    for (const name of entries) {
      for (const rel of _EXE_CANDIDATES) {
        const p = path.join(dir, name, ...rel);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* 不可读目录跳过 */ }
  return null;
}

function _systemPlaywrightDir() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  switch (process.platform) {
    case "win32": return path.join(home, "AppData", "Local", "ms-playwright");
    case "darwin": return path.join(home, "Library", "Caches", "ms-playwright");
    default: return path.join(home, ".cache", "ms-playwright");
  }
}

/** 找可用 Chromium 内核 exe：config.browsers_path > <cwd>/browsers > 系统 ms-playwright。 */
export function findChromiumExecutable(configPath) {
  const candidates = [
    configPath && String(configPath).trim() ? String(configPath).trim() : null,
    path.join(process.cwd(), "browsers"),
    _systemPlaywrightDir(),
  ].filter(Boolean);
  for (const dir of candidates) {
    const exe = _scanKernelDir(dir);
    if (exe) return exe;
  }
  return null;
}

// ============================================================
// 浏览器生命周期（懒启动单例 + 空闲回收 + 串行队列）
// ============================================================

let _ctx = null;          // 持久 BrowserContext 单例
let _ctxExe = null;       // 启动所用 exe（配置变更时重启）
let _ctxUA = null;        // 启动所用 UA（配置变更时重启）
let _idleTimer = null;
let _queue = Promise.resolve(); // 串行队列尾
let _detectedUA = null;   // 内核真实 UA 探测缓存（进程级，见 _resolveUserAgent）

// ============================================================
// [0726 反检测] UA 与内核版本对齐 + 自动化指纹补丁
// ============================================================
// why 不能再硬编码 UA 字符串（原 "Chrome/126.0.0.0 … Edg/126.0.0.0"）：
//   Chromium **自己**按内核真实版本发送 Sec-CH-UA / Sec-CH-UA-Full-Version-List 请求头，
//   而 userAgent option 只改 navigator.userAgent 与 User-Agent 头。硬编码版本与内核版本一旦不同
//   （本机内核 revision 1228 ≈ Chrome 138，声称 126），两者**当场自相矛盾**——这是比
//   "HeadlessChrome" 字样更硬的 bot 判据（正常浏览器不可能出现该矛盾）。0717 起 browser 通道被
//   频繁降级，此项是其中一条确定性成因。
//   对策=UA 版本永远取自内核自身：首次启动读 navigator.userAgent，仅把 "HeadlessChrome" 换成
//   "Chrome"（其余部分原样保留），版本号因此天然与 Sec-CH-UA 一致，且内核升级后自动跟随、永不腐烂。
// 用户可配 config.user_agent 完全覆盖（禁硬编码：值可改，代码只持默认行为）。

/** 从内核默认 UA 派生可用 UA：去 headless 字样，版本号原样保留（与 Sec-CH-UA 一致）。 */
function _deheadlessUA(ua) {
  return String(ua || "").replace(/HeadlessChrome/gi, "Chrome").replace(/\s*Headless\s*/gi, " ").trim();
}

/**
 * 决定本次启动使用的 UA。
 * 优先级：config.user_agent（显式覆盖）> 已探测缓存 > null（表示"本次需先探测"）。
 */
function _resolveUserAgent(config) {
  const explicit = String(config?.user_agent || "").trim();
  if (explicit) return explicit;
  return _detectedUA; // null = 尚未探测，_getContext 会走探测启动
}

// 自动化指纹补丁：headless shell 与真实 Chrome 的几处确定性差异。
// ⚠ 边界：只补**确定性缺失的标准 Web API**（真实 Chrome 一定有、headless 一定没有的），
//   不做行为伪装/不改渲染指纹——那属于对抗升级，收益不稳且会拖垮可维护性。
//   config.stealth=false 可整体关闭（用户可改）。
const _STEALTH_SCRIPT = `
(() => {
  try {
    // navigator.webdriver：--disable-blink-features=AutomationControlled 已处理多数情况，
    // 此处兜底（部分内核版本该 flag 不生效）
    if (navigator.webdriver) Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // window.chrome：真实 Chrome 一定存在，headless shell 缺失（最常被检测的一项）
    if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    // navigator.plugins：headless 为空数组，真实浏览器至少有内置 PDF 组件
    if (navigator.plugins && navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' }],
      });
    }
    // Notification 权限与 permissions API 的一致性（headless 下二者矛盾，是经典判据）
    if (window.navigator.permissions && window.Notification) {
      const _q = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : _q(p);
    }
  } catch { /* 补丁失败不影响页面功能，静默 */ }
})();
`;

function _profileDir() {
  return path.join(process.cwd(), "browsers", "search-profile");
}

function _armIdleClose() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => { closeBrowserSearch().catch(() => {}); }, IDLE_CLOSE_MS);
  // Deno/Node 均支持 unref：空闲定时器不阻止进程退出
  if (typeof _idleTimer?.unref === "function") _idleTimer.unref();
}

/** 单次启动持久上下文（UA 由调用方决定；null=用内核默认 UA，仅探测轮使用）。 */
async function _launchCtx(chromium, exe, ua, config) {
  const profileDir = _profileDir();
  fs.mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: exe,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--lang=zh-CN"],
    ...(ua ? { userAgent: ua } : {}),
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    ...(config?.proxy_url ? { proxy: { server: config.proxy_url } } : {}),
  });
  // 指纹补丁（每个新页面执行；config.stealth=false 关闭）
  if (config?.stealth !== false) {
    await ctx.addInitScript(_STEALTH_SCRIPT).catch(() => { /* 补丁失败不影响主功能 */ });
  }
  // [0726 资源预拦截] 图片/字体/音视频对"取文本"零价值，却占下载耗时与带宽的大头。
  //   ⚠⚠ **默认关闭**（storage 默认 block_resources:false），开启前请知悉实测代价：
  //     0726 三轮消融（每轮固定同一组查询、交替顺序）——开启时必应搜索耗时 25-27s 且全部超时失败，
  //     关闭时 2.5s 成功，三轮完全一致。25-27s ≈ 导航超时(15s)+等 URL 变化超时(12s)全部等满，
  //     即**导航根本没发生**：playwright 只要注册任意 route 就会**禁用 HTTP 缓存**、且每个请求都要
  //     回 Node 端判匹配，对本通道这种靠持久 profile 缓存加速的场景伤害远大于省下的图片流量。
  //     （先试过把 route("**/*")+resourceType 换成 URL 正则匹配想减少 IPC——无效，因为匹配本身
  //     就在 Node 端、且缓存禁用与匹配方式无关。归因换了两次才落到实处，记此防重蹈。）
  //     仅在"一次深抓大量页面、带宽比延迟重要"时值得开。
  //   ⚠ 刻意**不拦 stylesheet**：innerText 的可见性判定依赖 CSS（display:none 的内容不计入），
  //     拦掉 CSS 会让搜索页/正文页把隐藏的 SEO 关键词堆、折叠菜单文本一并读出来 = 引入噪音。
  if (config?.block_resources === true) {
    await ctx.route(
      /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|m4a|mov|avi)(?:[?#]|$)/i,
      (route) => route.abort().catch(() => {}),
    ).catch(() => { /* 路由注册失败=退化为不拦截，不影响主功能 */ });
  }
  return ctx;
}

/** 读内核真实 UA（开一张空白页读 navigator.userAgent，不发任何网络请求）。 */
async function _probeKernelUA(ctx) {
  const page = await ctx.newPage();
  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    const fixed = _deheadlessUA(ua);
    return fixed && /Chrome\/\d+/.test(fixed) ? fixed : null;
  } catch { return null; }
  finally { await page.close().catch(() => {}); }
}

async function _getContext(config) {
  const exe = findChromiumExecutable(config?.browsers_path);
  if (!exe) {
    throw new Error(
      "浏览器内核未就绪：未在 browsers_path/<项目根>/browsers/系统 ms-playwright 找到 Chromium——" +
      "可执行 `npx playwright install chromium` 安装（或在联网设置高级区配置 browsers_path 指向已有内核），或先切换其他引擎",
    );
  }
  const _wantUA = _resolveUserAgent(config);
  if (_ctx && _ctxExe === exe && _ctxUA === _wantUA) return _ctx;
  if (_ctx) await closeBrowserSearch().catch(() => {});

  let chromium;
  try {
    ({ chromium } = await import(PLAYWRIGHT_PKG));
  } catch (e) {
    throw new Error(`playwright-core 加载失败（离线或 npm 源不可达）：${e.message?.slice(0, 120)}`);
  }

  _ctx = await _launchCtx(chromium, exe, _wantUA, config);
  _ctxExe = exe; _ctxUA = _wantUA;

  // UA 探测轮（进程级只发生一次）：没有缓存 UA 且用户未显式配置时，先用内核默认 UA 起一次、
  //   读出真实版本、去 headless 字样后**重启**一次。之所以要重启而不是事后改：userAgent 是
  //   context 级创建参数，创建后无法变更（page.setExtraHTTPHeaders 只改 HTTP 头，JS 侧
  //   navigator.userAgent 仍是旧值 → 又制造一处自相矛盾，比不改更糟）。
  //   代价=进程首次搜索多约 1s；收益=UA 版本与 Sec-CH-UA 永久一致且随内核升级自动跟随。
  if (!_wantUA) {
    const probed = await _probeKernelUA(_ctx);
    if (probed) {
      _detectedUA = probed;
      await closeBrowserSearch().catch(() => {});
      _ctx = await _launchCtx(chromium, exe, probed, config);
      _ctxExe = exe; _ctxUA = probed;
      diag.log(`[browserSearch] UA 对齐内核版本: ${probed}`);
    } else {
      diag.warn("[browserSearch] 内核 UA 探测失败——沿用内核默认 UA（可能含 HeadlessChrome 字样，反爬面偏大；可用 web_search.user_agent 手动指定）");
    }
  }
  diag.log(`[browserSearch] Chromium 启动: ${exe}`);
  return _ctx;
}

/** 关闭浏览器（空闲回收/诊断重置用）。幂等。 */
export async function closeBrowserSearch() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const ctx = _ctx;
  _ctx = null; _ctxExe = null; _ctxUA = null;
  if (ctx) { try { await ctx.close(); } catch { /* 已崩溃/已关 */ } }
}

// ============================================================
// 拟人流搜索（必应）
// ============================================================

// ============================================================
// [0726] 被拒分类 + 就绪判定
// ============================================================
// why 被拒分类：原来"页面到手但无有机块"一律报「可能触发人机验证或页面改版」+页面开头 150 字。
//   这句话对**用户**不可执行（不知道该做什么）、对 **AI** 是误判土壤（0725 确诊：AI 把可恢复的
//   限流当成"联网功能坏了"，进而在后续轮次完全放弃联网）。分类后每一类给出**这一类专属的**
//   下一步动作，AI 与用户都能判断"该重试、该换源、还是该改配置"。
//   ⚠ 只做**响应形态**归类（HTTP 语义/页面自述），不做内容语义识别——不越"只做框架管道"的界。
const _BLOCK_KINDS = [
  // 0726 实测补入必应挑战页文案：本机出口触发时页面正文是「跳至内容 辅助功能反馈 N 最后一步
  //   请解决以下难题以继续」——原正则不含这些词，于是被误判成"页面改版（选择器失效）"，
  //   把一个**可换源/可重试**的临时拒绝报成了"我们的选择器坏了"，方向完全相反。
  { kind: "captcha", re: /验证码|人机验证|安全验证|请解决以下难题|解决以下难题以继续|captcha|recaptcha|hcaptcha|are you (?:a |not a )?robot|unusual traffic|异常流量|\/sorry\//i,
    hint: "触发人机验证——该源对本机出口 IP 的信任度不足。可换 browser_sources 里的其他源、改用 fetch 类引擎（搜狗/Tavily），或配置 proxy_url 换出口" },
  { kind: "ratelimit", re: /too many requests|请求(?:过于)?频繁|访问频率|rate limit|429|稍后再试|try again later/i,
    hint: "被限流——属可恢复的临时状态，稍后重试即可，不是联网功能故障。持续出现可调低搜索频率或换源" },
  { kind: "blocked", re: /access denied|forbidden|拒绝访问|blocked|你的请求被拒|not available in your (?:country|region)|该地区不可用|unavailable in your/i,
    hint: "该源拒绝本次访问（地区/策略限制）——换源或配置 proxy_url 换出口，重试无用" },
  { kind: "login", re: /请先登录|需要登录|sign in to continue|log ?in to continue|登录后查看/i,
    hint: "该源要求登录——browser 引擎的 profile 目录可保留登录态，也可换免登录源" },
];

/** 按页面文本归类拒绝形态。返回 null=未识别为拒绝（真·无结果/改版）。 */
function _classifyBlockPage(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  for (const b of _BLOCK_KINDS) if (b.re.test(s)) return b;
  return null;
}

/**
 * 提交搜索并等待导航真正发生（拟人流专用）。
 *
 * 【0726 实测确诊·这是 browser 通道最主要的失败源，不是"被拒"也不是"出口漂移"】
 *   原实现 `press("Enter")` 后**不等导航**直接 waitForSelector(结果块)。回车触发的是一次整页
 *   导航，在导航完成前当前 document 仍是**搜索首页**——首页永远不含 li.b_algo，于是 selector
 *   一路等到超时，最终报「无法解析出结果（可能触发人机验证或页面改版）」。
 *   实证（0726 单源 bing 复现）：失败页 innerText 开头是「Copilot 图片视频地图资讯…创建壁纸」
 *   ——必应**首页**导航栏原文，证明读的是提交前的页面。此前把这类失败归因为 bing 出口漂移/
 *   反爬升级并据此加了多源降级，方向偏了：根因是本地竞态，与出口无关。
 *   （成功案例只是导航恰好抢在 selector 轮询之前完成——竞态的典型表现：时快时慢、无规律。）
 * 判据取「URL 变化」而非固定 URL 模式：各源结果页 URL 形态不同（/search?q= 与 /s?wd=），
 *   URL 变化是所有源共有的确定性信号，源注册表因此不必为此新增声明字段。
 */
async function _submitAndWaitNav(page, timeoutMs) {
  const before = page.url();
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction((u) => location.href !== u, before, { timeout: Math.max(3000, timeoutMs) });
    await page.waitForLoadState("domcontentloaded", { timeout: Math.max(3000, timeoutMs) });
  } catch {
    // URL 未变=提交未生效（输入框未聚焦/被 JS 拦截）——不在此抛错，交由下游"零结果"分支
    // 带页面线索统一诊断（此处抛会丢失页面证据，反而更难定位）
    diag.warn("[browserSearch] 回车提交后 URL 未变化——可能未真正提交，继续按当前页面尝试解析");
  }
}

/**
 * 结果就绪判定：等到结果条数**稳定**（连续两次相同）或达到目标条数或超时。
 * why 不能只用 waitForSelector：它在**第一个**匹配元素出现时即返回，而搜索页的结果块是逐条
 *   渲染/异步补齐的——立刻 evaluate 常只拿到 2-3 条，之后被 domain_cap 一砍就剩 1 条，
 *   表现成"搜索质量差"而非"读early了"。这是取多少条的确定性因素，不是玄学等待。
 */
async function _waitResultsSettled(page, itemSel, want, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let last = -1;
  while (Date.now() < deadline) {
    const n = await page.locator(itemSel).count().catch(() => 0);
    if (n >= want && n === last) return n;   // 够数且已稳定
    if (n > 0 && n === last) return n;       // 不够数但已稳定（该源就这么多）
    last = n;
    await page.waitForTimeout(250);
  }
  return last > 0 ? last : 0;
}

/** 通用拟人流搜索（骨架，源无关）：打开首页→定位输入框→逐字打字→回车→等结果→声明式提取→解码。 */
async function _doSearchOneSource(query, config, srcKey) {
  const src = BROWSER_SOURCES[srcKey];
  const max_results = config?.max_results ?? 5;
  const ctx = await _getContext(config);
  const page = await ctx.newPage();
  try {
    if (src.mode === "url") {
      // 直达模式：结果页 URL 直接导航（首页输入框不可交互/无表单的源）
      await page.goto(src.queryUrl(query), { waitUntil: "domcontentloaded", timeout: _navTimeout(config) });
    } else {
      // 拟人流模式：首页 → 逐字打字 → 回车（反爬面最小，暖 profile 加成最大）
      await page.goto(src.home, { waitUntil: "domcontentloaded", timeout: _navTimeout(config) });
      const box = page.locator(src.inputSel).first();
      await box.click({ timeout: 5000 });
      await box.type(query, { delay: TYPE_DELAY_MS });
      await _submitAndWaitNav(page, _resultTimeout(config));
    }
    try {
      await page.waitForSelector(src.sel.item, { timeout: _resultTimeout(config) });
      // [0726 就绪判定] 首个结果块出现 ≠ 全部渲染完——再等条数稳定，避免只读到前 2-3 条
      await _waitResultsSettled(page, src.sel.item, Math.max(1, max_results), Math.min(_resultTimeout(config), 4000));
    } catch { /* 零命中在下方统一诊断 */ }

    // 提取逻辑与 user_browser 通道共用同一份（buildResultExtractExpr 单源）——源注册表改选择器
    //   只需改声明，两个执行环境自动跟随
    const raw = await page.evaluate(buildResultExtractExpr(src.sel, !!src.snippetFromText));

    if (raw.length === 0) {
      // 页面到手但无有机块 = 验证页/限流/改版/引擎异常——分类后带**可执行动作**抛错，不静默空
      const bodyFull = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      const bodyHead = bodyFull.slice(0, 150).replace(/\s+/g, " ");
      const blocked = _classifyBlockPage(bodyFull);
      if (blocked) {
        throw new Error(`浏览器搜索被拒（源=${src.label}，类型=${blocked.kind}）：${blocked.hint}。页面开头: ${bodyHead}`);
      }
      throw new Error(`浏览器搜索无法解析出结果（源=${src.label}）——页面已加载但未匹配到结果块，可能是该源页面改版（选择器失效）。页面开头: ${bodyHead}`);
    }

    const decode = _HREF_DECODERS[src.decode] || _HREF_DECODERS.none;
    const out = raw.slice(0, Math.max(1, max_results)).map((r) => ({
      title: r.title || "(无标题)",
      url: decode(r.href),
      // 与 webSearch.cleanSnippet 同口径（归一空白+截500）：innerText 已无标签/实体，只需机械清洗
      snippet: (r.snippet || "").replace(/\s+/g, " ").substring(0, 500).trim(),
      source: `browser:${srcKey}`, // 实际生效源上行可见（降级留痕，webSearch 的多引擎共识按此区分）
    }));
    // 跳转链接解析（源声明 resolveRedirect）：把 /link?url= 形态换成真实站点 URL——
    //   否则全部结果域名同为搜索引擎域，webSearch 的 domain_cap 会把它们当同站砍到只剩 2 条，
    //   且 AI 拿到的 URL 无法从字面判断来源站点。并发 HEAD 不跟随，读 Location；失败保留原 URL。
    if (src.resolveRedirect) await _resolveRedirects(out, ctx, config);
    return out;
  } finally {
    await page.close().catch(() => {});
    _armIdleClose();
  }
}

/** 并发解析 302 跳转真实地址（复用浏览器 context 的 cookie/代理；单条失败保留原 URL）。 */
async function _resolveRedirects(results, ctx, config) {
  const timeout = Math.min(Math.max(Number(config?.timeout_ms) || 0, 4000), 8000);
  await Promise.all(results.map(async (r) => {
    if (!r.url || !/^https?:/i.test(r.url)) return;
    try {
      const resp = await ctx.request.head(r.url, { maxRedirects: 0, timeout, failOnStatusCode: false });
      const loc = resp.headers()["location"];
      if (loc && /^https?:/i.test(loc)) r.url = loc;
    } catch { /* 解析失败保留跳转 URL（浏览器抓取时仍会自动跟随） */ }
  }));
}

/** 深抓正文（可选）：用同一浏览器实例把 top-N 结果的正文摘录进 snippet——喂 AI 的从"引擎摘要"升级为"页面正文"。
 *  config.deep_fetch_top_n=0 时整段跳过（默认，行为不变）；单条失败只跳过该条（保留原 snippet），不影响整体。 */
async function _deepFetchTopN(results, config) {
  const n = Math.max(0, Number(config?.deep_fetch_top_n) || 0);
  if (n <= 0 || results.length === 0) return results;
  const maxChars = Math.max(200, Number(config?.deep_fetch_max_chars) || 2000);
  for (let i = 0; i < Math.min(n, results.length); i++) {
    const r = results[i];
    if (!r.url || !/^https?:/i.test(r.url)) continue;
    try {
      const text = await _doFetchPage(r.url, config, maxChars);
      if (text && text.trim()) {
        r.snippet = text.replace(/\s+/g, " ").trim().slice(0, maxChars);
        r.deep_fetched = true;
      }
    } catch (e) {
      diag.log(`[browserSearch] 深抓失败（保留原摘要）: ${r.url} — ${String(e?.message || "").slice(0, 80)}`);
    }
  }
  return results;
}

/** 多源顺序降级：按 _sourceOrder 依次试，首个成功即返回；全败抛聚合错误（每源失败原因保留可见）。 */
async function _doSearchMultiSource(query, config) {
  const order = _sourceOrder(config);
  const errs = [];
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    try {
      const res = await _doSearchOneSource(query, config, key);
      if (i > 0) diag.warn(`[browserSearch] 源降级生效：${order.slice(0, i).join("/")} 失败 → ${key} 成功返回 ${res.length} 条`);
      return await _deepFetchTopN(res, config);
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 160);
      errs.push(`${BROWSER_SOURCES[key].label}: ${msg}`);
      if (i < order.length - 1) diag.warn(`[browserSearch] 源 ${key} 失败，降级下一源 ${order[i + 1]}: ${msg}`);
    }
  }
  throw new Error(`浏览器搜索全部内容源失败（${order.length} 源）——${errs.join(" | ")}`);
}

// 实例失效自愈：浏览器进程可能在两次操作之间死掉（被安全软件杀/自身崩溃/系统回收），
// 单例 _ctx 残留死引用会让后续所有操作恒抛 "has been closed"——按失效特征重建一次再试，
// 仍失败才原样上行（一次重建足以区分"实例死了"与"环境真不可用"，不做无限重试）。
async function _runWithRecovery(fn) {
  try {
    return await fn();
  } catch (e) {
    const _msg = String(e?.message || "");
    if (_ctx && /has been closed|browser.*closed|crashed|disconnected/i.test(_msg)) {
      diag.warn(`[browserSearch] 浏览器实例失效（${_msg.slice(0, 80)}）——重建后重试一次`);
      await closeBrowserSearch();
      return await fn();
    }
    throw e;
  }
}

/** 队列串行 + 失效自愈统一入口（搜索/抓页共用：单浏览器单 profile，操作互斥）。 */
function _enqueue(fn) {
  const run = _queue.then(() => _runWithRecovery(fn));
  // 队列尾吞错推进（错误由本次调用方接收，不阻塞后续排队者）
  _queue = run.catch(() => {});
  return run;
}

/**
 * 浏览器拟人流搜索（webSearch "browser" 引擎入口）。并发调用串行化（单浏览器单 profile）。
 * [0726 Chrome 扩用] 内部多源顺序降级（browser_sources，默认 bing→baidu；ddg 声明保留但默认不启用，见 :115-117）+ 可选 top-N 深抓正文
 *   （deep_fetch_top_n，默认 0=关）。整条链（多源+深抓）在同一 _enqueue 任务内，共用实例/队列/自愈。
 *   函数名保留 searchViaBrowserBing 兼容既有 import（webSearch 注册表/诊断），语义已是"多源"。
 * @param {string} query
 * @param {object} config - web_search 配置（max_results/timeout_ms/browsers_path/proxy_url/
 *                          browser_sources/deep_fetch_top_n/deep_fetch_max_chars 消费）
 * @returns {Promise<Array<{title:string,url:string,snippet:string,source:string,deep_fetched?:boolean}>>}
 */
export function searchViaBrowserBing(query, config) {
  return _enqueue(() => _doSearchMultiSource(query, config));
}

// ============================================================
// 浏览器渲染抓页（<browse> 通道增强，0717 凛倾拍板「为什么不做」）
// ============================================================

// 正文提取（Readability 式打分，页内执行）。
// why 不用现成库：@mozilla/readability 需要额外 npm 依赖 + DOM 注入，与「离线可启动」硬约束
//   和零新依赖取向冲突；而其核心（段落密度打分 + 链接密度惩罚）是可自持的百来行逻辑。
// why 需要它：原实现取 article/main/body 的 innerText——大多数站点没有 <article>/<main>，
//   于是**整页 body** 进 AI 上下文：导航栏、侧栏推荐、页脚版权、Cookie 横幅全在里面。
//   deep_fetch_max_chars 默认 2000 字被这些噪音吃掉大半，真正的正文反而被截断在外。
// 打分规则（经典 Readability 精简）：候选=含段落的块级容器；分数=段落长度累计（长段权重更高）；
//   链接密度 >0.5 的容器判为导航/列表直接淘汰；最高分容器不足 200 字则回退原策略。
const _EXTRACT_SCRIPT = `(() => {
  const NOISE = /(^|[-_ ])(nav|menu|header|footer|sidebar|aside|comment|related|recommend|share|social|advert|\\bads?\\b|promo|banner|cookie|popup|modal|breadcrumb|pagination|toolbar|subscribe|newsletter)([-_ ]|$)/i;
  const doc = document.cloneNode(true);
  for (const el of doc.querySelectorAll('script,style,noscript,iframe,svg,form,nav,header,footer,aside,button,select')) el.remove();
  for (const el of doc.querySelectorAll('[class],[id],[role]')) {
    const key = ((el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '') + ' ' + (el.getAttribute('role') || ''));
    if (NOISE.test(key)) el.remove();
  }
  const cands = new Map();
  for (const p of doc.querySelectorAll('p,li>p,td>p,article,section')) {
    const txt = (p.textContent || '').trim();
    if (txt.length < 25) continue;              // 太短的段落是标签/按钮文案，不参与打分
    const parent = p.parentElement;
    if (!parent) continue;
    // 长段落权重更高（正文特征），但开方抑制超长单段独占
    const score = Math.sqrt(txt.length) + (txt.match(/[,，。.；;]/g) || []).length;
    cands.set(parent, (cands.get(parent) || 0) + score);
    const gp = parent.parentElement;
    if (gp) cands.set(gp, (cands.get(gp) || 0) + score / 2);  // 祖父半权：正文常多层包裹
  }
  let best = null, bestScore = 0;
  for (const [el, score] of cands) {
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const linkLen = [...el.querySelectorAll('a')].reduce((n, a) => n + (a.textContent || '').length, 0);
    if (linkLen / txt.length > 0.5) continue;   // 链接密度过高=导航/目录/相关阅读，非正文
    if (score > bestScore) { bestScore = score; best = el; }
  }
  // 标题单独保留：打分只选"段落密度最高的容器"，而 h1/发布时间/作者常在该容器**之外**，
  //   0726 对比实测确认会被削掉（deno 博客页：旧策略含"Deno 2 发布公告/2024年10月9日/作者名"，
  //   新策略从正文首句开始）。标题与日期是 AI 判断资料时效与主题的关键元信息，必须补回——
  //   这是 Readability 原实现也单独返回 article.title 的原因，不是可选装饰。
  const h1 = (document.querySelector('h1') || {}).innerText || '';
  const title = (h1 || document.title || '').trim().replace(/\\s+/g, ' ');
  const withTitle = (body) => {
    if (!title) return body;
    return body.slice(0, 80).includes(title.slice(0, 20)) ? body : title + '\\n\\n' + body;
  };
  const bestText = best ? (best.innerText || best.textContent || '').trim() : '';
  if (bestText.length >= 200) return withTitle(bestText);
  // 回退原策略（正文太短/打分失败——短页面、SPA 骨架、纯列表页）
  const fb = document.querySelector('article') || document.querySelector('main') || document.body;
  return withTitle(fb ? (fb.innerText || '').trim() : '');
})()`;

/** 页面就绪：优先等网络空闲（资源已预拦截，通常很快达成），超时回退固定短等待。 */
async function _waitPageSettled(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 3000 });
  } catch {
    await page.waitForTimeout(600); // SPA/长轮询站点永不 networkidle——退回轻等首屏填充
  }
}

async function _doFetchPage(url, config, maxLength) {
  const ctx = await _getContext(config);
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: _navTimeout(config) });
    await _waitPageSettled(page);
    const text = await page.evaluate(_EXTRACT_SCRIPT);
    const _clean = (text || "").replace(/\n{3,}/g, "\n\n").trim();
    // 空正文**或极短正文**都要过被拒分类：0726 实测知乎页返回的正是 29 字「请您登录后查看更多
    //   专业优质内容」——非空所以旧判据放行，这段"正文"原样喂进 AI 上下文，AI 会当成页面真实
    //   内容作答（比报错更糟：错误可见，假内容不可见）。阈值 120 字=正常正文段落下限量级。
    if (_clean.length < 120) {
      const bodyFull = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      const blocked = _classifyBlockPage(bodyFull) || _classifyBlockPage(_clean);
      if (blocked) throw new Error(`页面抓取被拒（类型=${blocked.kind}）：${blocked.hint}`);
      if (!_clean) throw new Error("浏览器渲染后页面无可读正文");
      // 短但未识别为拒绝=可能真的是短页面，放行但留痕（不静默当正常长文）
      diag.warn(`[browserSearch] 正文仅 ${_clean.length} 字（疑似登录墙/付费墙/空壳页）: ${url}`);
    }
    return maxLength > 0 ? _clean.slice(0, maxLength) : _clean;
  } finally {
    await page.close().catch(() => {});
    _armIdleClose();
  }
}

/**
 * 浏览器渲染抓页：JS 渲染站点可读、反爬面小于裸 fetch。与搜索共用实例/队列/自愈。
 * ⚠ SSRF 责任边界：本函数不做 URL 校验——调用方（web/main.mjs fetchWebPage）负责
 *   首跳 assertSafeUrl + server 部署模式禁用（浏览器内后续跳转无法逐跳校验）。
 * @param {string} url
 * @param {object} config - web_search 配置（timeout_ms/browsers_path/proxy_url 消费）
 * @param {number} [maxLength=5000] - 正文截断长度（0=不截断）
 * @returns {Promise<string>}
 */
export function fetchPageViaBrowser(url, config, maxLength = 5000) {
  return _enqueue(() => _doFetchPage(url, config, maxLength));
}
