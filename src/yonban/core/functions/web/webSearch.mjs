/**
 * webSearch.mjs — 联网搜索引擎封装（P8 联网搜索底层驱动）。
 *
 * 【功能链】
 *   提供统一的联网搜索接口 executeWebSearch()，内部按配置选择引擎：
 *   - Chrome 浏览器拟人流（0717 凛倾拍板「以谷歌浏览器为主」曾为默认主通道，0726 改默认 multi 并发池后
 *     browser 因耗时不入默认池，需要时用户可在 config.engines 显式加入）：
 *     browserSearch.mjs headless Chromium 首页打字流，绕裸 fetch 被引擎投毒/降级（详见该模块头注释）
 *   - 裸 fetch 引擎（降级备选，SUPPORTED_ENGINES 单源）：Bing（HTML 解析）/ Edge（Bing 端点 + Edge UA）/ Google（google-sr 爬虫）
 *   - API 通道（非浏览器，进阶可选）：Tavily（API Key）/ SearXNG（用户自建实例，server 部署下校验内网安全）
 *   所有引擎返回统一 SearchResult 格式（title/url/snippet/source/score?），
 *   清洗 HTML 标签，应用超时控制（默认 8s，timeout_ms 可配），按 max_results 截取，
 *   过广告/噪音筛选（结构层+机械 URL 层+用户词表层+匹配层，见 assessNoise/filterNoise），
 *   软拦截确诊（结果全数与查询零相关 = 引擎投毒填充页，error 明示而非静默空），
 *   末端过 domain_whitelist/domain_blacklist 域名过滤 + 域名多样性截断（每域上限，防单站刷屏）。
 *   formatSearchResultsForP8()：把搜索结果格式化为供 P8 AI 消费的文本块。
 *
 * 【why】
 *   P8 联网（getPromptHandler S18）和 replyHandler <needWebSearch> 都需要搜索能力，
 *   两处共用同一封装避免重复。引擎失败不做隐式第二引擎兜底，改错误可见（error 随返回值
 *   上行进回喂内容，诊断面原则）：隐式串行兜底在所选引擎不可达的网络环境里只加时长不加结果。
 *   公开引擎白名单（ENGINE_REGISTRY menu:true 下拉项）：0710 凛倾拍板原三选，0717/0726 演进
 *   扩至 6 家（ddgs/browser/edge/bing/google/sogou）；（browserSearch.mjs 内部 BROWSER_SOURCES
 *   内容源注册表另算，仍为 bing/baidu/ddg 三家，两层白名单不同层不可混指）。各地区网络适配
 *   交给用户自选引擎 + 域名黑白名单，本模块不按地区做任何假设。
 *   server 部署模式下 SearXNG 端点经 assertSafeOutboundInServerMode 校验，
 *   防止多租户场景下用户自配 SearXNG 指向内网（SEC-F4 安全要求）。
 *
 * 【前端调用方式】
 *   前端不直接调用本模块（纯后端工具库）。
 *   触发路径 1（P8 主动联网）：
 *     getPromptHandler S18 → aiRunner.executeWebSearch() → 本模块 executeWebSearch()
 *     → 结果格式化 → 注入当轮 GetPrompt → AI 生成时能看到搜索结果
 *   触发路径 2（AI 请求联网）：
 *     AI 回复 <needWebSearch> → replyHandler → 本模块 executeWebSearch()
 *     → [0726 002拍板改道] 结果入 ideClient pendingResults 池（tool="_web_search_results"）→ 回合末/前置落地
 *       落 chatLog system 条（对话尾部，与 ideToolCall 结果同形态，落盘可回看）→ 下轮 prompt 天然含之
 *       （旧路 pendingChatSearchResults→INJ-chat-search-data 瞬态注入已停用于联网，仍服务 <memorySearch>）
 *   前端感知：搜索结果不直接广播，随下轮 AI 回复体现在对话内容中。
 *
 * 【关联链】
 *   ← aiRunner.mjs（executeWebSearch / buildInjectableSearchText — P8 联网 + P1 多轮搜索；
 *     formatSearchResultsForP8 由 buildInjectableSearchText 内部调用，aiRunner.mjs 未直接 import）
 *   ← replyHandler.mjs（executeWebSearch — <needWebSearch> 标签处理）
 *   → storage.mjs（diag — 诊断日志）
 *   → safe_fetch.mjs（assertSafeOutboundInServerMode — SearXNG 内网安全校验）
 *   外部 HTTP：Google（爬虫）/ Bing HTML 解析 / Tavily API / SearXNG API
 *
 * 【影响范围】
 *   - 纯读取（HTTP 外部请求），不写磁盘，不修改内存状态
 *   - 超时控制：默认 8s（timeout_ms 可配），AbortController 取消
 *   - 不广播 WS 事件
 *
 * 【使用效果】
 *   AI 在需要实时信息（新闻/文档/价格等）时能获取真实网络内容，
 *   搜索结果经清洗后以统一格式注入 prompt，不同引擎对前端完全透明。
 *
 * 导出：
 *   executeWebSearch(query, config) → Promise<SearchResult[]>
 *   formatSearchResultsForP8(results) → string（供 AI prompt 注入的格式化文本）
 *
 * 依赖：内置 fetch（Bing/SearXNG/Tavily），google-sr npm 包（Google 爬虫）
 */

import { fileURLToPath } from "node:url"; // Python 桥脚本路径解析（中文项目根必需，见 _ddgsBridgePath）

import { diag } from "../memory/storage_mod/storage.mjs";
// [SEC 安全同步 0722] reach 平台内容混入搜索结果前的中性化原语（零依赖模块，静态引入无循环）
import { neutralizeAngleBrackets, stripInvisibleUnicode, wrapUntrusted } from "../security/untrusted_content.mjs";
// ============================================================
// 代理支持 + 引擎可达性快速探测
// ============================================================

// 代理 fetch：用户配了 proxy_url 时生效。Clash TUN 全局接管环境下此项无需设（已全局走代理），
// 此功能面向纯 env 代理 / 非 TUN 用户。Deno 用 createHttpClient，Node 用 env 让 undici 生效。
function _makeProxiedFetch(proxyUrl) {
  if (!proxyUrl) return fetch;
  if (typeof Deno !== "undefined" && Deno.createHttpClient) {
    const client = Deno.createHttpClient({ proxy: { url: proxyUrl } });
    return (url, opts) => fetch(url, { ...opts, client });
  }
  if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.HTTP_PROXY = proxyUrl;
  }
  return fetch;
}

/**
 * 引擎可达性快速探测（HTTP HEAD 2s 超时，TLS+HTTP 双层验证）。
 * 不可达时抛错 fail-fast（2s 报错 vs 原 8s HTTP 超时才报失败）。
 * TCP-only probe 在透明代理/TUN 环境下无效（TCP 到代理虚拟 IP 秒通，HTTP 层才是真断点），
 * 故改用 HEAD 请求——经过 TLS 握手 + HTTP 往返，代理不通就 2s 内超时。
 */
async function probeReachable(host, timeoutMs = 2000, fetchImpl = fetch) {
  // [0726 proxy断链修] fetchImpl：探测必须与真实请求同通道（用户配 proxy 后，用裸 fetch 探测=测错通道误杀）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchImpl(`https://${host}/`, { method: "HEAD", signal: ctrl.signal, redirect: "manual" });
  } catch (e) {
    throw new Error(`${host} 不可达（${e.name === "AbortError" ? timeoutMs + "ms 超时" : e.message}）——检查网络或代理设置`);
  } finally {
    clearTimeout(timer);
  }
}

import { searchViaBrowserBing, resolveBingHref, findChromiumExecutable } from "./browserSearch.mjs";
// SEC-F4（红方 round2，多用户）：server 部署下用户自配 SearXNG 端点不可指内网。
import { assertSafeOutboundInServerMode } from "../security/safe_fetch.mjs"; // T3a·3.8: 新位 4 级回溯 src/（旧位 6 级）

// ============================================================
// 引擎注册表（单一权威源：label/菜单可见性/探测主机/执行函数一处声明）
// ============================================================
// why（0717 凛倾「后端插件为什么都是打补丁」收口）：原 SUPPORTED_ENGINES 清单、归一化白名单、
//   probe 主机映射（ENGINE_HOSTS）、执行分派 if-else 是同一事实的四份散点副本——加/删引擎要摸
//   四处且已实际漂移（browser 探测特判）。收成注册表后归一化=键存在性、probe=probeHost 字段、
//   分派=run 字段、前端下拉=menu 过滤派生，加引擎只增一条声明零新分支。
//   probeHost:null=刻意不探测（browser 走浏览器网络栈≠fetch 栈，用裸 fetch 探测=用错栈误杀，
//   0714 opLog 实证裸 fetch 对 bing HEAD 超时而真浏览器可通）；函数形态=运行时从 config 取主机（searxng）。
//   0717 凛倾拍板「以谷歌浏览器为主」曾默认=browser：headless Chromium 拟人流实测 10/10
//   高相关；裸 fetch 通道对低信任请求被引擎投毒/降级（0717 实证），降为备选。0726 改默认=multi
//   多平台并发（见 DEFAULT_ENGINE/DEFAULT_MULTI_ENGINES），browser 因耗时不入默认池，可显式加入。
//   menu:false 的 API 通道（tavily/searxng）不进浏览器面下拉（凛倾 2026-07-10 拍板白名单机制，
//   0717/0726 公开引擎白名单成员数扩至 6 家，但 API 通道不进下拉的边界不变），
//   进阶配置走联网设置高级区（key/URL 有值即可把 engine 直设为该值）。
//   引擎执行函数均为本文件 async function 声明（提升）或顶部 import——注册表置于其前安全。
// [0726 proxy断链修] run 第三参 f=代理感知 fetch（_makeProxiedFetch 产物）——此前 _pFetch 创建后零消费，
//   Deno 下 proxy_url 对全部 fetch 引擎实际不生效（仅 browser 引擎经 Playwright launch 真接线）。
//   browser 忽略 f（浏览器网络栈自带 proxy 接线）；google 走 google-sr 库内部 fetch 注不进（已知局限，见 :121）。
const ENGINE_REGISTRY = {
  // [0726 002「我们的项目有python,直接按照插件接个shell」] Python 通道：唯一能过 TLS 指纹层的路
  //   （实测本机 bing 1.7s / yandex 1.4s，同机 Deno fetch 对 bing 是 8s 超时）。
  //   probeHost:null=不做 fetch 探测（探测走的正是被拒的那个栈，会误杀本可用的通道）。
  ddgs: { label: "Python 通道（多引擎·免 key）", menu: true, probeHost: null, run: (q, c) => searchViaDdgs(q, c) },
  browser: { label: "Chrome 浏览器（拟人搜索）", menu: true, probeHost: null, run: (q, c) => searchViaBrowserBing(q, c) },
  edge: { label: "Edge（必应通道）", menu: true, probeHost: "www.bing.com", run: (q, c, f) => searchViaBing(q, c, "edge", f) },
  bing: { label: "必应 Bing", menu: true, probeHost: "www.bing.com", run: (q, c, f) => searchViaBing(q, c, "bing", f) },
  google: { label: "Google", menu: true, probeHost: "www.google.com", run: (q, c) => searchViaGoogle(q, c) }, // google-sr 库内部 fetch，proxy_url 注不进（Node env 副作用路径除外）
  // [0726 调研落地] 免 key 免浏览器兜底：本机实测唯一裸 fetch 能拿到完整结果页的源（详见 searchViaSogou 头注释）
  sogou: { label: "搜狗（免 key）", menu: true, probeHost: "www.sogou.com", run: (q, c, f) => searchViaSogou(q, c, f) },
  tavily: { label: "Tavily (API)", menu: false, probeHost: "api.tavily.com", run: (q, c, f) => searchViaTavily(q, c, f) },
  searxng: {
    label: "SearXNG (自建)", menu: false, run: (q, c, f) => searchViaSearXNG(q, c, f),
    probeHost: (c) => { try { return c?.searxng_url ? new URL(c.searxng_url).hostname : null; } catch { return null; } },
  },
};
export const DEFAULT_ENGINE = "multi";

// [0726 002「不需要选择平台,直接是多平台注入」] 并发平台池：用户不再选引擎，engine="multi"（默认）
//   即并发下列平台，谁回来算谁。池成员判据=**快且免 key**（速度是搜索的第一属性）：
//     ddgs  — Python 通道，TLS 指纹层唯一能过 bing 的路（实测 1.7s）；未装 ddgs 时本项失败由其余兜底
//     sogou — 裸 fetch 唯一稳定可用源（实测 1.0s）
//     browser — 拟人流质量高但 2.5~27s 且间歇挨人机验证，**不入默认池**（会吃满时间窗），
//               需要时用户可在 engines 显式加入
//   用户可用 config.engines 覆盖成员（禁硬编码：值可改，代码只持默认）。
export const DEFAULT_MULTI_ENGINES = ["ddgs", "sogou"];

// [0726 存量配置升级] 改 storage 默认表**只对新建配置生效**——已存在的 _config.json 里
//   engine 仍是旧出厂默认 "browser"（002 的 代码001/p1自驱动 实测即如此），新键全部缺失。
//   不做这一步，多平台并发/正文校验对所有老角色卡一次都不会触发（改完等于没改）。
//   判据沿用 beilu 既有升级范式（预设/INJ 的"与某一代出厂默认逐字一致才覆写，用户改过的一字不动"）：
//   只升级历代**出厂默认值**，用户主动选过的（tavily/searxng/sogou 等需要额外配置才能用的）原样保留。
const _LEGACY_DEFAULT_ENGINES = ["browser"]; // 0717-0726 的出厂默认；再往前无存量

/** 存量配置归一化（纯函数，不写盘）：仅在内存中把旧出厂默认提升为当前默认。 */
function _upgradeLegacyEngine(config, engine) {
  if (!_LEGACY_DEFAULT_ENGINES.includes(engine)) return engine;
  if (Array.isArray(config?.engines) && config.engines.length > 0) return engine; // 用户显式配过平台列表=尊重
  diag.log(`[webSearch] 存量配置 engine="${engine}"（旧出厂默认）→ 本次按 "multi" 多平台并发执行；如需固定单平台请在联网设置显式选择`);
  return "multi";
}

/** 解析本次要跑的平台列表：engines 显式 > engine 单值（非 multi）> 默认池。 */
function _resolveEngineList(config, engine) {
  const explicit = Array.isArray(config?.engines) ? config.engines : null;
  const raw = explicit && explicit.length > 0
    ? explicit
    : (engine && engine !== "multi" ? [engine] : DEFAULT_MULTI_ENGINES);
  const ok = raw.map((s) => String(s || "").trim()).filter((s) => ENGINE_REGISTRY[s]);
  return ok.length > 0 ? ok : ["sogou"]; // 全部非法时回退到免 key 且无依赖的那个，不让搜索直接死
}

// 前端引擎下拉数据（getDataHandler 附 web_search_engines 下发，前端零语义副本）——注册表派生。
// [0726] 首项 multi = 调度模式而非注册表成员，需显式并入：它是默认值，若不在下拉选项里，
//   前端 <select> 找不到匹配 option 会回落到首项，用户一保存就把 engine 写成那个单平台值
//   （典型的"后端改默认、前端把它写回去"时序陷阱）。放首位也使其成为选项集的语义默认。
export const SUPPORTED_ENGINES = [
  { value: "multi", label: "多平台并发（推荐）" },
  ...Object.entries(ENGINE_REGISTRY)
    .filter(([, e]) => e.menu)
    .map(([value, e]) => ({ value, label: e.label })),
];

// ============================================================
// 统一返回结构
// ============================================================

/**
 * @typedef {Object} SearchResult
 * @property {string} title    - 结果标题
 * @property {string} url      - 结果链接
 * @property {string} snippet  - 内容摘要/片段
 * @property {string} source   - 来源引擎标识
 * @property {number} [score]  - 相关度评分（Tavily 提供）
 */

// ============================================================
// Tavily API
// ============================================================

/**
 * 通过 Tavily API 执行搜索
 * @param {string} query - 搜索关键词
 * @param {object} config - 搜索配置
 * @param {string} config.tavily_api_key - Tavily API Key（键名与 storage.mjs web_search 默认表一字不差，读写同名收口）
 * @param {number} [config.max_results=5] - 最大结果数
 * @param {number} [config.timeout_ms=8000] - 超时毫秒数
 * @returns {Promise<SearchResult[]>}
 */
async function searchViaTavily(query, config, fetchImpl = fetch) {
  const {
    tavily_api_key,
    max_results = 5,
    timeout_ms = 8000,
  } = config;

  if (!tavily_api_key) {
    throw new Error("Tavily API Key 未配置");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const response = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavily_api_key,
        query,
        max_results,
        search_depth: "basic",
        include_answer: true,
        include_raw_content: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Tavily API ${response.status}: ${errText.substring(0, 200)}`,
      );
    }

    const data = await response.json();

    /** @type {SearchResult[]} */
    const results = [];

    // Tavily 可能返回一个 AI 生成的回答
    if (data.answer) {
      results.push({
        title: "Tavily AI 摘要",
        url: "",
        snippet: data.answer,
        source: "tavily_answer",
        score: 1.0,
      });
    }

    // 实际搜索结果
    if (Array.isArray(data.results)) {
      for (const r of data.results) {
        results.push({
          title: r.title || "(无标题)",
          url: r.url || "",
          snippet: cleanSnippet(r.content || ""),
          source: "tavily",
          score: r.score ?? 0,
        });
      }
    }

    console.log(`[webSearch] Tavily: "${query}" → ${results.length} 条结果`);
    return results.slice(0, max_results + 1); // +1 for AI answer
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      throw new Error(`Tavily 搜索超时 (${timeout_ms}ms)`);
    }
    throw e;
  }
}

// ============================================================
// SearXNG API
// ============================================================

/**
 * 通过 SearXNG 自托管实例执行搜索
 * @param {string} query - 搜索关键词
 * @param {object} config - 搜索配置
 * @param {string} config.searxng_url - SearXNG 实例 URL（如 http://localhost:8080）。
 *   注意：SearXNG 实例默认不开 JSON 输出（settings.yml formats 需含 json），未开时返回 403——
 *   错误信息随 error 上行可见，用户可据此自查实例配置。
 * @param {number} [config.max_results=5] - 最大结果数
 * @param {number} [config.timeout_ms=8000] - 超时毫秒数
 * @returns {Promise<SearchResult[]>}
 */
async function searchViaSearXNG(query, config, fetchImpl = fetch) {
  const {
    searxng_url,
    max_results = 5,
    timeout_ms = 8000,
  } = config;

  if (!searxng_url) {
    throw new Error("SearXNG URL 未配置");
  }

  // 规范化 URL
  let baseUrl = searxng_url.replace(/\/+$/, "");
  if (!baseUrl.startsWith("http")) {
    baseUrl = "http://" + baseUrl;
  }

  const searchUrl = new URL("/search", baseUrl);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("engines", "google,bing"); // 上游聚合引擎与浏览器白名单口径一致
  await assertSafeOutboundInServerMode(searchUrl.toString()); // SEC-F4：server 下拒内网 SearXNG 目标

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const response = await fetchImpl(searchUrl.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "beilu-memory/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `SearXNG ${response.status}: ${errText.substring(0, 200)}`,
      );
    }

    const data = await response.json();

    /** @type {SearchResult[]} */
    const results = [];

    if (Array.isArray(data.results)) {
      for (const r of data.results) {
        results.push({
          title: r.title || "(无标题)",
          url: r.url || "",
          snippet: cleanSnippet(r.content || ""),
          source: r.engine || "searxng",
          score: r.score ?? 0,
        });
      }
    }

    console.log(`[webSearch] SearXNG: "${query}" → ${results.length} 条结果`);
    return results.slice(0, max_results);
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      throw new Error(`SearXNG 搜索超时 (${timeout_ms}ms)`);
    }
    throw e;
  }
}

// ============================================================
// Bing / Edge（免费 HTML 解析，无需 API key；官方 Bing Search API 已于 2025-08 退役）
// ============================================================

// Bing 给 Chrome UA 返回 JS 渲染空壳（2026 实测：0 个 b_algo 块），只有 Edge UA 能拿到可解析的传统 HTML。
// 两个变体统一用 Edge UA。
const _BING_UA = {
  bing: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
};

// Bing /ck/a 跳转解码已迁 browserSearch.resolveBingHref（browser 与 fetch 两通道共用单源，
// 依赖方向 webSearch → browserSearch 单向）。本地别名保持既有调用点名字不变。
const _resolveBingHref = resolveBingHref;

/**
 * 通过 Bing 搜索页 HTML 解析执行搜索（零 API key）。
 * 解析锚点：结果条目 <li class="b_algo">，标题链接在 <h2><a href>，摘要在条目内 <p>。
 * 站点改版会破坏解析（爬虫共性风险）——解析零命中时抛错让 error 可见，不静默返回空。
 * @param {string} query - 搜索关键词
 * @param {object} config - 搜索配置
 * @param {number} [config.max_results=5] - 最大结果数
 * @param {number} [config.timeout_ms=8000] - 超时毫秒数
 * @param {"bing"|"edge"} [uaVariant="bing"] - UA 变体（edge=Edge 浏览器 UA，同端点）
 * @returns {Promise<SearchResult[]>}
 */
async function searchViaBing(query, config, uaVariant = "bing", fetchImpl = fetch) {
  const {
    max_results = 5,
    timeout_ms = 8000,
  } = config;

  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${max_results}`;
  diag.log(`Bing搜索(${uaVariant}): "${query}" → ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": _BING_UA[uaVariant] || _BING_UA.bing,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en,zh;q=0.8,ja;q=0.6",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Bing ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // 逐条目解析：先切出 <li class="b_algo"> 块，再在块内取标题链接与摘要（比全局双正则配对更抗错位）
    /** @type {SearchResult[]} */
    const results = [];
    const itemPattern = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    const titlePattern = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
    const snippetPattern = /<p[^>]*>([\s\S]*?)<\/p>/i;
    let m;
    while ((m = itemPattern.exec(html)) !== null && results.length < max_results) {
      const block = m[1];
      const t = titlePattern.exec(block);
      if (!t || !t[1]) continue;
      const s = snippetPattern.exec(block);
      results.push({
        title: t[2].replace(/<[^>]+>/g, "").trim() || "(无标题)",
        url: _resolveBingHref(t[1]),
        snippet: cleanSnippet(s ? s[1] : ""),
        source: uaVariant,
      });
    }

    if (results.length === 0) {
      // 页面拿到了但一条都没解出 = 触发验证页/改版/被限流，报错可见优于静默空结果
      throw new Error(`Bing 返回页面无法解析出结果（可能触发人机验证或页面改版，HTML ${html.length} 字符）`);
    }

    console.log(`[webSearch] Bing(${uaVariant}): "${query}" → ${results.length} 条结果`);
    return results;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      throw new Error(`Bing 搜索超时 (${timeout_ms}ms)`);
    }
    throw e;
  }
}

// ============================================================
// 搜狗（免 key 免浏览器的 HTML 通道）
// ============================================================

/**
 * 搜狗网页搜索（裸 fetch，零 key 零浏览器内核）。
 *
 * [0726 002「去看看其他项目怎么做」调研落地] 本机实测（同一 query 同一时刻）：
 *   bing/cn.bing 裸 fetch=200 但零 b_algo（被投毒/降级，0717 早有实证）、DDG html/lite=202 挑战页、
 *   Google=200 但结构不可解、Mojeek/Startpage/Brave/Ecosia=挑战或 403，
 *   **只有搜狗裸 fetch 拿到完整结果页（383KB / 11 个 vrwrap 块）**——故补此引擎作免 key 兜底。
 * 解析范式（同源同解析同取舍）：
 *   ① 结果块 class="vrwrap" ② 标题链接取块内首个 <a>（h3 内）③ 链接是 /link?url= 跳转 →
 *   绝对化后交给下游抓取跟随（浏览器/深抓会自动跟随，与 browser 引擎的 baidu 源同款处理）
 *   ④ 摘要在搜狗页里嵌在多层 div 内且类名不稳，按该范式**留空由标题+深抓承担**，不硬抠不稳选择器。
 * @param {string} query
 * @param {object} config
 * @param {Function} [fetchImpl=fetch] - 代理感知 fetch（_makeProxiedFetch 产物）
 * @returns {Promise<SearchResult[]>}
 */
async function searchViaSogou(query, config, fetchImpl = fetch) {
  const { max_results = 5, timeout_ms = 8000 } = config;
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  diag.log(`搜狗搜索: "${query}" → ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": _BING_UA.bing, // 复用既有真实浏览器 UA 常量（单源，不再散写第二份 UA）
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`搜狗 ${response.status}: ${response.statusText}`);
    const html = await response.text();

    /** @type {SearchResult[]} */
    const results = [];
    // 逐条目：切 vrwrap 块（下一个 vrwrap 或收尾为界），块内取首个带 href 的 <a>
    const itemPattern = /<div[^>]*class="[^"]*\bvrwrap\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bvrwrap\b|<div[^>]*id="pagebar_container"|$)/gi;
    const linkPattern = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    let m;
    while ((m = itemPattern.exec(html)) !== null && results.length < max_results) {
      const block = m[1];
      const a = linkPattern.exec(block);
      if (!a || !a[1]) continue;
      const title = a[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!title) continue;
      // 跳转链接绝对化（/link?url=... → https://www.sogou.com/link?url=...），下游抓取自动跟随
      const href = a[1].startsWith("http") ? a[1] : `https://www.sogou.com${a[1].startsWith("/") ? "" : "/"}${a[1]}`;
      results.push({ title, url: href, snippet: "", source: "sogou" });
    }

    if (results.length === 0) {
      throw new Error(`搜狗返回页面无法解析出结果（可能触发验证或页面改版，HTML ${html.length} 字符）`);
    }
    // 跳转还原：搜狗 /link?url= 是 **JS 跳转**（实测 HEAD/GET 均 200 无 Location，220 字节正文里
    //   window.location.replace("真实URL")）——必须 GET 一次取正文解析。不还原的后果实测确凿：
    //   全部结果域名同为 sogou.com → domain_cap=2 把 5 条砍成 2 条，且 AI 看不出来源站点。
    //   并发解析、单条失败保留跳转链（下游浏览器抓取仍会自动跟随），总耗时≈一次请求。
    await Promise.all(results.map(async (r) => {
      if (!r.url.includes("/link?url=")) return;
      try {
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), Math.min(timeout_ms, 6000));
        const rr = await fetchImpl(r.url, { headers: { "User-Agent": _BING_UA.bing, "Referer": "https://www.sogou.com/" }, signal: c2.signal });
        clearTimeout(t2);
        const body = await rr.text();
        const jm = body.match(/(?:window\.location\.replace|window\.location\.href\s*=|URL=)\s*\(?["']?(https?:\/\/[^"'\s>)]+)/i);
        if (jm && jm[1]) r.url = jm[1].replace(/&amp;/g, "&");
      } catch { /* 解析失败保留跳转链 */ }
    }));
    console.log(`[webSearch] 搜狗: "${query}" → ${results.length} 条结果`);
    return results;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") throw new Error(`搜狗搜索超时 (${timeout_ms}ms)`);
    throw e;
  }
}

// ============================================================
// Google（免费爬虫，需要 google-sr npm包）
// ============================================================

/**
 * 通过 google-sr npm包执行Google搜索（免费）
 * @param {string} query - 搜索关键词
 * @param {object} config - 搜索配置
 * @param {number} [config.max_results=5] - 最大结果数
 * @param {number} [config.timeout_ms=8000] - 超时毫秒数
 * @returns {Promise<SearchResult[]>}
 */
async function searchViaGoogle(query, config) {
  const { max_results = 5, timeout_ms = 8000 } = config;

  try {
    const { search, OrganicResult } = await import("npm:google-sr@^6.0.0");
    const queryResult = await Promise.race([
      search({ query, parsers: [OrganicResult], requestConfig: {} }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Google 搜索超时")), timeout_ms)),
    ]);

    const organicResults = queryResult.filter((item) => !item.isAd).slice(0, max_results);

    if (organicResults.length === 0) {
      // 错误可见：0 条有机结果几乎必是被挡而非真无结果——实测（2026-07-10 本机）Google 对无 JS
      //   客户端返回 200 + 空壳页（无 h3，Google 自 2025 起搜索页强制 JS 渲染），google-sr 解析为空。
      //   静默返回 [] 会让"引擎被挡"表现成"搜索没内容"，与 Bing 解析零命中同一口径抛错。
      throw new Error("Google 返回 0 条有机结果（Google 搜索页需 JS 渲染，纯 fetch 爬虫大概率被挡；或触发人机验证）");
    }

    /** @type {SearchResult[]} */
    const results = organicResults.map((item) => ({
      title: item.title || "(无标题)",
      url: item.link || "",
      snippet: cleanSnippet(item.description || ""),
      source: "google",
    }));

    console.log(`[webSearch] Google: "${query}" → ${results.length} 条结果`);
    return results;
  } catch (e) {
    console.warn(`[webSearch] Google 搜索失败（可能需要安装 google-sr）:`, e.message);
    throw e;
  }
}

// ============================================================
// Python 通道（ddgs）—— TLS 指纹层，JS 运行时内无法自持
// ============================================================
// why 见 ddgs_bridge.py 头注释。要点：本机对 bing 的裸请求 Deno fetch 8s 超时、playwright
//   ctx.request 亦失败，而本通道 1.7s 稳定返回——同机同出口同时段，唯一变量是 primp 的
//   TLS/JA3 指纹伪装。改 UA 属应用层（UA 说 Chrome 而 TLS 说不是 = 更强 bot 信号），
//   传输层指纹在 Deno/Node 里改不了，故走进程边界跨语言解决（002 0726 拍板）。
// 依赖 `pip install ddgs`，缺失时诚实报错给安装动线（不自动装、不静默降级）。

// [0726 002「以后直接检测然后自动安装」] 依赖自动安装（进程级一次）。
//   why 后台异步而非同步等待：首次 pip install 可能 30s+（远超搜索 timeout_ms），同步等会被外层
//   超时砍掉——既装不完也拿不到结果。改为「本次该平台诚实失败 → 后台装 → 下次可用」，
//   多平台并发本就允许单平台缺席（其余平台兜底），用户侧感知不到中断。
//   why 进程级只触发一次：pip 失败通常是环境问题（无网/无权限/无 Python），每次搜索都重装
//   会把失败成本叠加到每一次查询上。重启后端即可重新尝试。
//   开关 python_auto_install（默认开，用户可关）——安装是环境变更，须留可关闭出口。
let _ddgsInstallState = "idle"; // idle | installing | done | failed

function _autoInstallDdgs(pyCmd) {
  if (_ddgsInstallState !== "idle") return;
  _ddgsInstallState = "installing";
  diag.warn("[webSearch] 检测到 Python 搜索通道依赖缺失 → 后台自动安装 ddgs（本次搜索由其余平台兜底）");
  // 刻意不 await：调用方立即返回，安装在后台进行
  new Deno.Command(pyCmd, {
    args: ["-m", "pip", "install", "ddgs", "--quiet", "--disable-pip-version-check"],
    stdout: "piped", stderr: "piped",
  }).output().then((r) => {
    _ddgsInstallState = r.success ? "done" : "failed";
    if (r.success) diag.log("[webSearch] ddgs 自动安装完成——下次搜索即可使用 Python 通道");
    else diag.warn(`[webSearch] ddgs 自动安装失败：${new TextDecoder().decode(r.stderr || new Uint8Array()).slice(0, 300)}`);
  }).catch((e) => {
    _ddgsInstallState = "failed";
    diag.warn(`[webSearch] ddgs 自动安装异常：${String(e?.message || e).slice(0, 200)}`);
  });
}

/** 桥脚本绝对路径（随本体分发，相对本文件解析，零机器路径）。
 *  ⚠ 必须走 fileURLToPath 而不是 new URL().pathname：后者返回**百分号编码**路径，
 *  项目根目录含中文（beilu-与你之诗）时会解成 beilu-%E4%B8%8E... 导致 python 找不到文件；
 *  它还负责剥掉 Windows 盘符前的斜杠。0726 实测踩过。 */
function _ddgsBridgePath() {
  return fileURLToPath(new URL("./ddgs_bridge.py", import.meta.url));
}

/**
 * Python 通道搜索。
 * @param {string} query
 * @param {object} config - python_cmd（空=自动 win:python / 其他:python3）、ddgs_backend、
 *                          max_results、timeout_ms、proxy_url 消费
 * @returns {Promise<SearchResult[]>}
 */
async function searchViaDdgs(query, config) {
  const {
    python_cmd = "",
    ddgs_backend = "auto",
    max_results = 5,
    timeout_ms = 15000,
    proxy_url = "",
  } = config || {};

  if (typeof Deno === "undefined" || typeof Deno.Command !== "function") {
    throw new Error("Python 搜索通道需要 Deno 运行时（Deno.Command 不可用）");
  }
  // 空=自动：与 beilu-ppt 的 pythonCmd 同义同默认（win→python，其他→python3），用户可配
  const py = String(python_cmd).trim() || (Deno.build.os === "windows" ? "python" : "python3");
  // 桥内超时（秒）比外层进程超时短，让库先自己超时并给出结构化错误，而不是被外层砍进程丢诊断
  const innerSec = Math.max(3, Math.floor(Number(timeout_ms) / 1000) - 2);

  // [0726 002「注意图片类型的读取」] category 正交于 backend：text|images|news 三族字段名不同
  //   （images 无 href/body），桥按 category 分派方法与取值——若共用 text 取法会静默返回 0 条。
  const _cat = String(config?.search_category || "text").toLowerCase();
  const cmd = new Deno.Command(py, {
    // -X utf8：Windows 下 CJK 查询词与输出的编码双保险（beilu-ppt 同款，踩过坑）
    args: ["-X", "utf8", _ddgsBridgePath(), query, String(max_results), String(ddgs_backend), String(innerSec), String(proxy_url || ""), _cat, String(config?.ddgs_region || "")],
    stdout: "piped",
    stderr: "piped",
  });

  let out;
  try {
    // 外层硬超时：子进程可能因网络挂死不返回，AbortSignal 保证本函数一定收敛
    out = await Promise.race([
      cmd.output(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Python 通道超时（${timeout_ms}ms）`)), timeout_ms)),
    ]);
  } catch (e) {
    // spawn 失败（python 不在 PATH）与超时在此合流：两者都要给可执行动线，不折叠成"搜索失败"
    const m = String(e?.message || e);
    if (/os error 2|NotFound|program not found/i.test(m)) {
      throw new Error(`未找到 Python（命令：${py}）——请安装 Python 或在联网设置填写 python_cmd 绝对路径，也可改用其他搜索引擎`);
    }
    throw new Error(`Python 搜索通道执行失败：${m.slice(0, 160)}`);
  }

  const stdout = new TextDecoder().decode(out.stdout || new Uint8Array()).trim();
  const stderr = new TextDecoder().decode(out.stderr || new Uint8Array()).trim();
  // ⚠ 退出码非 0 且 stdout 空才算真失败：桥在依赖缺失/库异常时是**正常退出 + ok:false**，
  //   直接按 code 判死会把结构化错误折叠成无信息的"进程失败"（spawn 类调用的经典陷阱）
  if (!stdout) {
    throw new Error(`Python 搜索通道无输出（退出码 ${out.code}）${stderr ? "：" + stderr.slice(0, 200) : ""}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Python 搜索通道输出非 JSON（前 200 字）：${stdout.slice(0, 200)}`);
  }
  if (!parsed.ok) {
    // 依赖缺失 → 后台自动安装（不阻塞本次；本次该平台失败由并发的其余平台兜底）
    if (parsed.need_install && config?.python_auto_install !== false) _autoInstallDdgs(py);
    throw new Error(parsed.error || "Python 搜索通道未返回结果");
  }

  return (parsed.results || []).map((r) => {
    const out = {
      title: r.title || "(无标题)",
      url: r.url,
      snippet: cleanSnippet(r.snippet || ""),
      // 实际生效后端与类别都上行可见（诊断可辨；类别决定下游是否跳过正文校验）
      source: `ddgs:${parsed.backend || ddgs_backend}${_cat !== "text" ? ":" + _cat : ""}`,
    };
    // 图片/新闻的专有字段透传（消费方按需读取；未读取=行为与纯文本结果一致，无破坏）
    if (r.image) out.image = r.image;
    if (r.thumbnail) out.thumbnail = r.thumbnail;
    if (r.width) out.width = r.width;
    if (r.height) out.height = r.height;
    if (r.date) out.date = r.date;
    if (_cat !== "text") out.category = _cat;
    return out;
  });
}

// ============================================================
// 正文校验（002 0726「正文用关键词看正文内容匹配」）
// ============================================================
// why：多平台并发后结果变多，但**标题像而正文不对**的条目会混进来并拿到高分——0726 实测
//   查 "deno 2.0 release notes"，搜狗返回的 "Linux 2.0 Release Notes"/"GNOME 2.0 Desktop"
//   拿到 0.579/0.56（标题词面命中率高），而正文与 deno 毫无关系。仅凭标题+引擎摘要（通常 <200 字）
//   无法分辨这类"词面像"，必须看正文。
// 与 fetchWebPage 的分工（search/extract 能力分离，职责不同不互替）：那边是"AI 深读某一页"，
//   带 reach 平台路由与浏览器降级，重而全；这里是批量快速取文本只为打分，轻而快，两者不互相替代。
// 三条防退化约束：
//   ① 并发 + 整体时间窗：正文校验不得把"多平台并发"省下的时间又吃回去。
//   ② 抓取失败**不惩罚**（保持原分）：抓不到的原因多是反爬/超时，与相关性无关，
//      按"没抓到=不相关"处理会把正经站点误杀。
//   ③ 只降权不删除：低匹配条目排到后面并标注，最终判断权留给 AI（纯事实呈现，非代为裁决）。
// 附带收益：抓到的正文顺带把 snippet 从"引擎摘要"升级为"正文摘录"，喂 AI 的信息密度提升。

/** 极简正文取文本（只为打分，不做 Readability 级提取——那属于 extract 能力，见上方分工说明）。 */
function _htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 用正文内容校验相关性：并发抓 top-N 结果正文，用查询词算匹配分回写并重排。
 * @param {SearchResult[]} results - 已排序结果（原地增补字段）
 * @param {string} query - 原始查询（整串，用于 CJK bigram 匹配）
 * @param {string[]} terms - 拆出的关键词
 * @param {object} config
 * @param {function} fetchImpl - 代理感知 fetch
 * @returns {Promise<SearchResult[]>} 按"正文校验后"次序重排的结果
 */
async function verifyByContent(results, query, terms, config, fetchImpl = fetch) {
  const topN = Number.isInteger(config?.content_verify_top_n) ? config.content_verify_top_n : 5;
  if (topN <= 0 || results.length === 0) return results;
  const windowMs = Math.max(1000, Number(config?.content_verify_window_ms) || 3000);
  const maxChars = Math.max(500, Number(config?.content_verify_max_chars) || 4000);
  // 图片类结果跳过正文校验：判据不同（图片相关性不看页面正文）、且抓来源页多是图床/画廊壳页，
  //   既拿不到有效文本又白白吃掉时间窗。新闻类保留校验（有正文，语义与文本一致）。
  const targets = results.slice(0, topN).filter((r) => r.category !== "images");
  if (targets.length === 0) return results;

  // 阶段一：并发抓正文（只取文本，不打分）
  const deadline = new Promise((resolve) => setTimeout(() => resolve("__WINDOW__"), windowMs));
  const fetched = await Promise.all(targets.map(async (r) => {
    if (!r.url || !/^https?:/i.test(r.url)) return null;
    try {
      await assertSafeOutboundInServerMode(r.url); // SSRF 横切（async，与本文件 :308 同一道闸）
      const got = await Promise.race([
        fetchImpl(r.url, {
          // 复用既有真实浏览器 UA 常量（单源，不散写第二份 UA——与 :478/:517 同口径）
          headers: { "User-Agent": _BING_UA.bing, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
          signal: AbortSignal.timeout(windowMs),
        }).then(async (resp) => (resp.ok ? (await resp.text()).slice(0, 120000) : null)),
        deadline,
      ]);
      if (!got || got === "__WINDOW__") return null; // 超窗/失败=不惩罚（约束②）
      const text = _htmlToText(got).slice(0, maxChars);
      if (text.length < 80) return null; // 正文太短（空壳/登录墙）无判据，同样不惩罚
      return { r, text };
    } catch { return null; /* 单条失败不影响整体（约束②） */ }
  }));

  // 阶段二：**在这批正文之间**算 BM25（含 IDF），而不是逐篇算词面命中率。
  //   why 必须是 IDF 加权：0726 实测，查 "deno 2.0 release notes" 时
  //   "Release Notes for the GNOME 2.0 Desktop" 用简单命中率拿到 0.8——因为 release/notes/2.0
  //   三个**通用词**都命中，而唯一的区分词 deno 没命中却不影响得分。IDF 正是给"在本批文档里
  //   到处都出现的词"降权、给"少数文档才有的词"升权，deno 与 release 的权重因此拉开。
  //   _tokenizeForMatch 自带 CJK bigram，故中英文查询共用这一条路径，无需分支。
  const hits = fetched.filter(Boolean);
  if (hits.length > 0) {
    const qTokens = _tokenizeForMatch(`${query} ${terms.join(" ")}`);

    // maxP（最佳段落聚合）：把正文切成重叠窗口，各窗口独立打分、取该文最高分。
    //   why：整篇打分会被长文稀释——0726 实测「Release Notes for the GNOME 2.0 Desktop」整篇
    //   拿 0.399，高过真正相关的 deno 文章 0.151，因为长文里 release/notes/2.0 反复出现堆了分。
    //   passage-level 检索的公认结论是"按最佳段落排序比按整篇排序更有效"（maxP 聚合，
    //   文献报告最高 +20%），且窗口作为检索单元也让 IDF 统计更细粒度。
    const WIN = 600, STEP = 300;
    const passages = [];        // 扁平窗口集合（IDF 在窗口级统计 = passage 作检索单元）
    const owner = [];           // 每个窗口属于哪条结果
    hits.forEach((h, hi) => {
      const t = h.text;
      if (t.length <= WIN) { passages.push(t); owner.push(hi); return; }
      for (let s = 0; s < t.length; s += STEP) {
        passages.push(t.slice(s, s + WIN));
        owner.push(hi);
        if (s + WIN >= t.length) break;
      }
    });
    const pScores = _bm25Normalized(qTokens, passages);
    const best = new Array(hits.length).fill(0);
    pScores.forEach((sc, i) => { if (sc > best[owner[i]]) best[owner[i]] = sc; });

    // 核心词覆盖闸：BM25 只加分不扣分——查询的**区分词**完全缺席时，通用词的高频仍能堆出高分
    //   （GNOME 页面一次 "deno" 都没有却拿 0.399，就是这么来的）。
    //   取本批文档里 df 最低（最独特）的那些 query token 作为核心词，正文完全不含 → 判定不相关。
    //   why 用 df 而不是词长/词性：独特性必须相对**当前这批候选**来判，脱离语境的词表会腐烂。
    const docTexts = hits.map((h) => h.text.toLowerCase());
    // 词边界匹配：ASCII token 必须整词命中——否则 _tokenizeForMatch 把 "2.0" 拆出的 "0"/"2"
    //   会用子串命中**每一篇**文档（任何含数字的地方），把 df 统计彻底污染；CJK bigram 无词边界概念，仍用 includes
    const hasTok = (text, tk) => (/^[a-z0-9_]+$/.test(tk) ? new RegExp(`\\b${tk}\\b`).test(text) : text.includes(tk));
    // 核心词候选**不能复用 _tokenizeForMatch**：它对 CJK 产出 bigram，而 bigram 会跨词边界——
    //   "装饰器用法" 切出的 "器用" 被选作核心词后，正经的装饰器文章因不含这个碎片而被误罚
    //   （0726 实测）。核心词要的是"用户心里的那个词"，故按原查询的空格/标点切分取整词。
    const qUniq = [...new Set(
      String(query).toLowerCase()
        .split(/[\s,，。、；;:：!！?？"'“”‘’（）()【】\[\]<>《》|/\\]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && !/^\d+(?:\.\d+)?$/.test(s)), // 纯数字无区分力，排除
    )];
    const dfOf = (tk) => docTexts.reduce((n, d) => n + (hasTok(d, tk) ? 1 : 0), 0);
    const withDf = qUniq.map((tk) => ({ tk, df: dfOf(tk) })).filter((x) => x.df > 0).sort((a, b) => a.df - b.df);
    // 核心词=df 最低的前 3 个（最具区分力）；权重取 IDF，越独特的词缺席惩罚越重
    const core = withDf.slice(0, 3).map((x) => ({ ...x, w: Math.log((hits.length + 1) / (x.df + 0.5)) + 0.1 }));
    const wSum = core.reduce((s, c) => s + c.w, 0) || 1;

    hits.forEach((h, i) => {
      const lower = h.text.toLowerCase();
      const missing = core.filter((c) => !hasTok(lower, c.tk));
      // 覆盖率=命中核心词的 IDF 权重占比；连续因子而非二值闸——二值会把"部分相关"一刀切掉，
      //   而 0.25 的下限保证"完全不含区分词"的条目一定排在含区分词的之后，但仍可见（判断权留给 AI）
      const rawCov = core.length === 0 ? 1 : (wSum - missing.reduce((s, c) => s + c.w, 0)) / wSum;
      // 指数化放大缺失惩罚：线性 coverage 下，缺最关键词但命中其余修饰词仍有 ~0.45 覆盖率
      //   （0726 实测 "Linux 2.0 Release Notes" 缺 deno 却因命中 release/notes 拿到 0.509）。
      //   ^2 让"缺关键词"从"少拿一点"变成"显著掉队"，而全命中者不受影响（1^2=1）。
      const coverage = Math.pow(rawCov, 2);
      h.r.content_match = Math.round(best[i] * (0.2 + 0.8 * coverage) * 1000) / 1000;
      if (missing.length > 0) h.r.content_core_missing = missing.map((c) => c.tk).join("/");
      if (h.text.length > 200) h.r.snippet = h.text.slice(0, 500); // 附带收益：摘要升级为正文摘录
    });
  }

  // 正文分**连续**并入融合分，不用绝对阈值做二值降权。
  //   why 不用阈值：0726 实测两种二值方案都错——①绝对阈值（<0.12 才降权）漏掉了 GNOME 的 0.376，
  //   那条明明缺 deno；②"缺最独特词就降权"在中文查询上误伤——"typescript 5 装饰器 用法" 里 df
  //   最低的是"用法"而非主题词 typescript/装饰器，于是正经的装饰器文章反被打成不相关。
  //   统计上无法可靠区分"主题实体"与"修饰词"，故不做硬判定：coverage 已把缺词惩罚连续地算进
  //   content_match，这里只让它按比例调节融合分，排序自然拉开而不制造一刀切的误杀。
  const thr = typeof config?.content_verify_threshold === "number" ? config.content_verify_threshold : 0.12;
  const REF = 0.5; // 正文分达到此值即视为充分相关（不再加成），避免长文堆词者反超
  let marked = 0;
  for (const r of results) {
    if (typeof r.content_match !== "number") continue; // 没抓到=不惩罚（约束②）
    const f = 0.45 + 0.55 * Math.min(1, r.content_match / REF);
    r.relevance = Math.round((r.relevance ?? 0) * f * 1000) / 1000;
    if (r.content_match < thr) { r.content_mismatch = true; marked++; }
  }
  if (marked > 0) diag.log(`[webSearch] 正文校验：${marked} 条正文与查询匹配度 < ${thr}（已标注，排序已连续降权）`);
  return results.slice().sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
}

// ============================================================
// 结果清洗
// ============================================================

/**
 * 清洗搜索结果片段：去除 HTML 标签、多余空白、广告痕迹
 * @param {string} text
 * @returns {string}
 */
function cleanSnippet(text) {
  if (!text) return "";

  return (
    text
      // 移除 HTML 标签
      .replace(/<[^>]+>/g, " ")
      // 移除 HTML 实体
      .replace(/&[a-z]+;/gi, " ")
      .replace(/&#\d+;/g, " ")
      // 移除多余空白
      .replace(/\s+/g, " ")
      // 截断过长的片段
      .substring(0, 500)
      .trim()
  );
}

// ============================================================
// 通用联网套件：关键词优化 + 结果排序/去重/摘要（K1+C9，单一权威）
// ============================================================
// 设计意图（凛倾 2026-06-10）：executeWebSearch 是「通用联网套件」的唯一入口。
// 主AI回复链（replyHandler <needWebSearch>）、分身链（clone web_search 工具）、
// beilu-web 壳（searchViaBeilu 委托）三路径全部收口到此处，共用同一套
// 关键词优化 + 排序/去重/摘要增强。不引入外部付费依赖（纯本地算法）。

// 中英常见停用词/语气词（关键词优化用，去噪不去实体）
const _STOPWORDS = new Set([
  "的", "了", "吗", "呢", "啊", "吧", "呀", "嘛", "哦", "哈", "请", "帮我", "帮", "我想", "想",
  "一下", "这个", "那个", "怎么", "如何", "什么", "是不是", "可以", "能不能", "麻烦", "搜索", "查一下", "查查", "查",
  "the", "a", "an", "of", "to", "is", "are", "please", "help", "me", "i", "want", "how", "what", "search", "for", "about",
]);

/**
 * 查询预处理（0717 官方直搜范式改造，对标 claude 官方搜索模式）。
 * - query **原样直传**保语义：现代搜索引擎是语义引擎，自然语言问题句（"X 为什么 Y 2026"）
 *   的检索质量优于碎词——旧行为（去停用词+拆词改写 query）是布尔检索时代的补丁，
 *   会破坏查询意图（0717 凛倾对标截图拍板废除改写，仅保留超长截断）。
 * - terms 仍按去停用词分词产出，但只作下游**评分/匹配信号**（rankAndDedupe 相关度、
 *   assessNoise no_match 判定），不再回写 query。
 * - `|` OR 分组语法原样保留供调用方多查；纯空白回退原始。
 * @param {string} rawQuery
 * @returns {{ query: string, terms: string[], orGroups: string[] }}
 */
export function optimizeQuery(rawQuery) {
  const _raw = (rawQuery || "").trim();
  if (!_raw) return { query: "", terms: [], orGroups: [] };

  // OR 分组（用户显式 | 语法）— 不破坏，原样保留供调用方多查
  const orGroups = _raw.includes("|")
    ? _raw.split("|").map((s) => s.trim()).filter(Boolean)
    : [];

  // 分词去停用词（仅产 terms 评分信号，不改写 query）
  const _tokens = _raw
    .replace(/[，。、！？；：""''（）【】]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const _kept = _tokens.filter((t) => !_STOPWORDS.has(t.toLowerCase()));
  const terms = _kept.length > 0 ? _kept : _tokens;

  let query = _raw;
  if (query.length > 200) query = query.substring(0, 200).trim();

  return { query, terms, orGroups };
}

// ============================================================
// [0726 算法v2·002「优化筛选算法+通过检查的算法」] 匹配/评分工具区
// 设计依据：设计_搜索筛选评分算法v2_20260726.md（范式来源：mem0 bm25.ts 零依赖BM25、
// dify tablestore 1-exp(-0.15s) 单参归一、RRF k=60 三仓一致默认、koishi/kilocode 编辑距离阈值）
// ============================================================

/** 匹配 token 化：ASCII 词 + CJK 字符 bigram（中文无空格句子的子词级匹配单元；单字 query 兜底整字）。
 *  为什么 bigram：原 no_match/relevance 用整串 includes，"B站弹幕协议" vs "哔哩哔哩直播弹幕"=0 命中
 *  （误杀+投毒误报共同根因）；bigram 交集给出连续匹配度，零依赖同步，无需分词器。 */
function _tokenizeForMatch(s) {
  const t = String(s || "").toLowerCase();
  const out = t.match(/[a-z0-9_]+/g) || [];
  const c = t.replace(/[^一-鿿぀-ヿ가-힯]/g, "");
  for (let i = 0; i < c.length - 1; i++) out.push(c.slice(i, i + 2));
  if (c.length === 1) out.push(c);
  return out;
}

/** 连续匹配度 0..1：query 的匹配 token 在 text 中的命中率（子串级）。三处消费：assessNoise no_match
 *  判定、软拦截连续可疑度、（评分层用 BM25 不用此函数——此函数是筛选层的轻量档）。 */
export function cjkMatchScore(query, text) {
  const q = String(query || ""), t = String(text || "").toLowerCase();
  if (!q || !t) return 0;
  const toks = [...new Set(_tokenizeForMatch(q))];
  if (toks.length === 0) return t.includes(q.toLowerCase()) ? 1 : 0;
  let hit = 0;
  for (const k of toks) if (t.includes(k)) hit++;
  return hit / toks.length;
}

/** BM25 相关度（mem0 bm25.ts 范式，k1=1.5 b=0.75；语料=本次结果集，token 空间=_tokenizeForMatch）
 *  → 每 doc 一个原始分，经 1-exp(-0.15·s) 归一到 [0,1)（dify tablestore 单参归一）。
 *  文档长度归一自动解决原公式"长摘要占便宜"；title 权重由调用方在 doc 文本中复写 title 实现。 */
function _bm25Normalized(queryTokens, docs) {
  const k1 = 1.5, b = 0.75, N = docs.length;
  if (N === 0) return [];
  const docTokens = docs.map((d) => _tokenizeForMatch(d));
  const avgLen = docTokens.reduce((s, d) => s + d.length, 0) / N || 1;
  const qSet = [...new Set(queryTokens)];
  const df = new Map();
  for (const q of qSet) { let n = 0; for (const dt of docTokens) if (dt.includes(q)) n++; df.set(q, n); }
  return docTokens.map((dt) => {
    let score = 0;
    const tf = new Map();
    for (const w of dt) tf.set(w, (tf.get(w) || 0) + 1);
    for (const q of qSet) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const idf = Math.log((N - df.get(q) + 0.5) / (df.get(q) + 0.5) + 1);
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * dt.length) / avgLen));
    }
    return 1 - Math.exp(-0.15 * score);
  });
}

/** 归一化编辑距离比 0..1（0=相同）。标题近重判定用（转载/镜像/内容农场同文异 URL）。 */
function _levRatio(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n] / Math.max(m, n);
}

/** URL 追踪参数剥除白名单（原 `[?#].*` 全剥导致 B站 ?p=2/?p=3 分P误合并——语义参数必须保留）。 */
const _TRACKING_PARAMS = /^(utm_\w+|ref|ref_src|spm|from|share_\w+|vd_source|fbclid|gclid|igshid|_trms?)$/i;
function _normUrlForDedupe(u) {
  const raw = String(u || "");
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const keep = [];
    for (const [k, v] of url.searchParams) if (!_TRACKING_PARAMS.test(k)) keep.push(`${k}=${v}`);
    return `${url.hostname}${url.pathname.replace(/\/+$/, "")}${keep.length ? "?" + keep.sort().join("&") : ""}`.toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/#.*$/, "").toLowerCase();
  }
}

/** 评分权重默认表（铁律：权重不写死在公式里；config.rank_weights 可整体/逐项覆盖）。
 *  各信号先归一 [0,1] 再加权；分母按激活信号数自适应（mem0 范式：信号缺席不惩罚——
 *  browser/bing 无 engineScore 时不再被 engineScore*3 死项拖平）。 */
const RANK_WEIGHTS = {
  engine_score: 3,   // 引擎自带相关度（tavily/searxng 有；browser/bing 无→信号不激活）
  position: 1.5,     // 引擎原始位次 RRF 1/(60+rank)·61 归一（引擎排序是强先验，原公式完全丢弃）
  consensus: 1.5,    // 多引擎共识（同 URL 多引擎命中）
  bm25: 2.5,         // BM25 相关度（title 复写×2 加权）
  info: 0.5,         // 摘要信息量
  integrity: 0.5,    // URL/标题完整度
};

/**
 * 结果去重（规范化 URL → 标题近重）+ 多信号归一加权排序。
 * [0726 算法v2] 排序=Σ(归一信号×权重)/Σ(激活信号权重)；权重单源 RANK_WEIGHTS ← config.rank_weights 覆盖。
 * @param {SearchResult[]} results
 * @param {string[]} terms - optimizeQuery 产出的关键词（与原始 query 拼接进匹配 token）
 * @param {object} [config] - { rank_weights?: object, title_dedupe_threshold?: number }
 * @returns {SearchResult[]}
 */
export function rankAndDedupe(results, terms = [], config = {}) {
  if (!Array.isArray(results) || results.length === 0) return [];

  // ① URL 去重（追踪参数白名单剥除，语义 query 保留）——记录原始位次（引擎排序先验）
  const _byKey = new Map();
  results.forEach((r, idx) => {
    const key = _normUrlForDedupe(r.url) || (r.title || "").trim().toLowerCase();
    if (!key) return;
    if (_byKey.has(key)) {
      const prev = _byKey.get(key);
      prev._hits = (prev._hits || 1) + 1;
      prev._pos = Math.min(prev._pos, idx);
      if ((r.score ?? 0) > (prev.score ?? 0)) {
        prev.title = r.title || prev.title;
        prev.snippet = (r.snippet || "").length > (prev.snippet || "").length ? r.snippet : prev.snippet;
        prev.score = r.score;
      }
    } else {
      _byKey.set(key, { ...r, _hits: 1, _pos: idx });
    }
  });

  // ② 标题近重合并（编辑距离比 < 阈值判近重；≤4 字符标题免疫防误合并短词）
  const _titleThr = typeof config?.title_dedupe_threshold === "number" ? config.title_dedupe_threshold : 0.15;
  const _items = [];
  for (const r of _byKey.values()) {
    const t = (r.title || "").trim().toLowerCase();
    const near = t.length > 4 ? _items.find((x) => {
      const xt = (x.title || "").trim().toLowerCase();
      return xt.length > 4 && _levRatio(t, xt) < _titleThr;
    }) : null;
    if (near) {
      near._hits = (near._hits || 1) + (r._hits || 1);
      near._pos = Math.min(near._pos, r._pos);
      if ((r.snippet || "").length > (near.snippet || "").length) near.snippet = r.snippet;
    } else {
      _items.push(r);
    }
  }

  // ③ 多信号归一加权（自适应分母：信号缺席不惩罚）
  const W = { ...RANK_WEIGHTS, ...(config?.rank_weights || {}) };
  const _qTokens = _tokenizeForMatch([...(terms || [])].join(" "));
  // title 复写 ×2 = 标题命中权重高于摘要（BM25 词频侧实现，不引第二公式）
  const _bmScores = _qTokens.length > 0
    ? _bm25Normalized(_qTokens, _items.map((r) => `${r.title || ""} ${r.title || ""} ${r.snippet || ""}`))
    : _items.map(() => 0);
  const _maxHits = Math.max(1, ..._items.map((r) => (r._hits || 1) - 1));

  const _scored = _items.map((r, i) => {
    const sig = [];
    if (typeof r.score === "number" && r.score > 0) sig.push([W.engine_score, Math.min(r.score, 1)]);
    sig.push([W.position, 61 / (60 + (r._pos + 1))]); // RRF k=60 单引擎位次，归一 (0,1]
    if ((r._hits || 1) > 1) sig.push([W.consensus, ((r._hits || 1) - 1) / _maxHits]);
    if (_qTokens.length > 0) sig.push([W.bm25, _bmScores[i]]);
    sig.push([W.info, Math.min((r.snippet || "").length / 200, 1)]);
    sig.push([W.integrity, (r.url ? 0.6 : 0) + (r.title && r.title !== "(无标题)" ? 0.4 : 0)]);
    const num = sig.reduce((s, [w, v]) => s + w * v, 0);
    const den = sig.reduce((s, [w]) => s + w, 0) || 1;
    return { r, _rank: num / den };
  });

  _scored.sort((a, b) => b._rank - a._rank);
  return _scored.map((s) => {
    const { _hits, _pos, ...clean } = s.r; // 剥内部字段
    // [0726 002「算法去优化搜索内容,看占比」] 回写本地算分 relevance（0..1）——此前 _rank 算完即弃，
    //   下游（P8 的 formatSearchResultsForP8 / 主 AI 回喂块）只在 r.score>0 时打印相关度，而 score
    //   仅 tavily/searxng 提供 → 默认 browser/搜狗引擎下**每条结果零相关度数字**，AI 只能凭排序次序猜。
    //   命名用 relevance 不覆盖 score：score=引擎自带分（外部事实），relevance=本地多信号融合分（我们算的）。
    clean.relevance = Math.round(s._rank * 1000) / 1000;
    return clean;
  });
}

/**
 * 模拟真人浏览输入 — 框架接口占位（K1 ⑤，凛倾 2026-06-10）。
 * 本轮仅预留接口，完整实现（真人节奏的打字/滚动/点击、反爬规避）属于
 * **分身行为层大件**，由分身专项驱动，列待决，不在本任务硬做。
 * 调用方传 mode:"browse" 时进入此分支，当前返回未实现标记，不抛异常。
 * @param {string} _url
 * @param {object} _config
 * @returns {Promise<{results: SearchResult[], error: string, engine: string, browse: true}>}
 */
async function browseAsHuman(_url, _config) {
  // TODO[分身专项驱动]: 接入真人浏览输入（节奏化 fetch/headless + 反爬）。
  // 现状：beilu-web/main.mjs fetchWebPage 提供裸 fetch 抓页能力，可作 browse 的底层；
  // 真人模拟（停顿/滚动/输入框打字）需分身行为层实现，见 06_执行记录 待决项。
  return {
    results: [],
    error: "browse 模式（模拟真人浏览）尚未实现——已预留框架接口，待分身专项驱动",
    engine: "browse",
    browse: true,
  };
}

// ============================================================
// 域名黑白名单（用户可配，凛倾 2026-07-10 拍板"加"）
// ============================================================
// 语义与"外部 origin 白名单默认空白交用户自配"原则同构：白名单空 = 不限（不锁死默认体验），
// 黑名单命中即拒。匹配口径 = hostname 后缀匹配（"example.com" 同时命中 www.example.com）。
// 当前仅 executeWebSearch 结果过滤消费（本文件 :1474）；<browse> 路径（web/main.mjs fetchWebPage）
// 未接入本白名单，仅经 assertSafeUrl 做 SSRF 私网校验（isDomainAllowed 未被 web/main.mjs 引用）。

/** 提取 hostname（非法 URL 返回 ""，交由调用方按不允许处理）。 */
function _hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** 域名后缀匹配：host === entry 或 host 以 "." + entry 结尾。 */
function _hostMatches(host, entry) {
  const e = String(entry || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!e) return false;
  return host === e || host.endsWith("." + e);
}

/**
 * 判定 URL 是否通过域名黑白名单。
 * @param {string} url
 * @param {object} [config] - { domain_whitelist?: string[], domain_blacklist?: string[] }
 * @returns {boolean} true=允许
 */
export function isDomainAllowed(url, config) {
  const host = _hostOf(url);
  if (!host) return false; // 无法解析的 URL 一律不放行（fail-closed）
  const bl = Array.isArray(config?.domain_blacklist) ? config.domain_blacklist : [];
  if (bl.some((e) => _hostMatches(host, e))) return false;
  const wl = Array.isArray(config?.domain_whitelist) ? config.domain_whitelist : [];
  if (wl.length === 0) return true; // 白名单空 = 不限
  return wl.some((e) => _hostMatches(host, e));
}

// ============================================================
// 广告/噪音识别与筛选（凛倾 2026-07-10：先把排查广告/噪音、识别筛选与匹配做出来）
// ============================================================
// 分层设计（机制进代码、词表进配置数据层）：
//   ① 结构层（引擎解析时）：Bing 只取 b_algo 有机块（广告在 b_ad 块，结构性排除）；
//      google-sr 已滤 isAd——广告的第一道排查在解析锚点，不进 SearchResult 流。
//   ② 机械层（本节 AD_URL_RULES）：广告点击跳转/追踪域的 URL 形态是跨站点稳定的机械特征
//      （aclick/aclk 点击计费链、doubleclick 等投放域），与内容无关，属框架管道可硬识别。
//   ③ 词表层（config.noise_keywords）：促销/垃圾内容词命中过滤。词表放配置数据层由用户维护，
//      代码只持机制不内置内容词——遵守"只做框架管道不做内容识别"+"代码禁产生硬编码词库"。
//   ④ 匹配层（no_match）：≥2 个查询词在 title+snippet+url 全部零命中且引擎零评分 = 与查询
//      不匹配的填充结果，判垃圾丢弃（单词查询不启用，避免误杀同义改写）。
//   被滤结果不静默消失：flag+条目经 noise_dropped 上行，diag 留痕（诊断面原则）。

// 机械广告特征（URL 形态，非内容判断）：
//   - 点击计费跳转链：bing.com/aclick、googleadservices /aclk、adclick
//   - 广告投放/追踪域：doubleclick / amazon-adsystem / taboola / outbrain / criteo / adsrvr
const AD_URL_RULES = [
  /(^|\.)bing\.com\/aclick/i,
  /googleadservices\./i,
  /\/aclk(\?|$)/i,
  /doubleclick\.net/i,
  /amazon-adsystem\./i,
  /taboola\.com/i,
  /outbrain\.com/i,
  /criteo\.(com|net)/i,
  /adsrvr\.org/i,
  /adclick\./i,
];

// 搜索引擎自链（相关搜索/站内导航混进有机位 = 噪音，非目标内容）
// [0726] 补搜狗/百度域：新增的 sogou 引擎与 browser 引擎 baidu 源都会混入自家相关搜索链接
//   （实测搜狗结果第 2 条是 sogou.com/?query=… 的站内相关搜索，非目标内容）
const SELF_LINK_HOSTS = ["bing.com", "www.bing.com", "cn.bing.com", "google.com", "www.google.com", "sogou.com", "www.sogou.com", "baidu.com", "www.baidu.com"];

/**
 * 单条结果噪音识别：返回命中的 flag（null=干净）。
 * @param {SearchResult} r
 * @param {string[]} terms - optimizeQuery 产出的查询词
 * @param {string[]} noiseKeywords - 用户配置的内容噪音词（config.noise_keywords）
 * @returns {string|null} "ad_url"|"self_link"|"noise_keyword"|"no_match"|"empty"|null
 */
export function assessNoise(r, terms = [], noiseKeywords = [], noMatchThreshold = 0.15) {
  const url = r?.url || "";
  const host = _hostOf(url);
  const hay = `${r?.title || ""} ${r?.snippet || ""}`.toLowerCase();

  if (!(r?.title || "").trim() && !(r?.snippet || "").trim()) return "empty";
  if (url && AD_URL_RULES.some((re) => re.test(url))) return "ad_url";
  if (host && SELF_LINK_HOSTS.includes(host)) return "self_link";
  for (const kw of noiseKeywords) {
    const k = String(kw || "").trim().toLowerCase();
    if (k && hay.includes(k)) return "noise_keyword";
  }
  // [0726 算法v2] no_match 判定：整串 includes → cjkMatchScore 连续分（中文 bigram 子词级）。
  //   原 terms.length>=2 门槛删除——中文单块 query（"B站弹幕协议"拆不开）该层原先直接失效；
  //   连续分天然适配单块 query。引擎带分结果（tavily/searxng）仍豁免。阈值可配（no_match_threshold）。
  if (!(typeof r?.score === "number" && r.score > 0) && terms.length > 0) {
    const hayFull = `${hay} ${url.toLowerCase()}`;
    if (cjkMatchScore(terms.join(" "), hayFull) < noMatchThreshold) return "no_match";
  }
  return null;
}

/**
 * 结果集噪音筛选：识别 → 分流（kept/dropped），dropped 带 flag 供诊断与上行。
 * @param {SearchResult[]} results
 * @param {string[]} terms
 * @param {object} [config] - { noise_filter?: boolean, noise_keywords?: string[] }
 * @returns {{kept: SearchResult[], dropped: Array<{title:string,url:string,flag:string}>}}
 */
export function filterNoise(results, terms = [], config = {}) {
  if (config?.noise_filter === false || !Array.isArray(results)) {
    return { kept: Array.isArray(results) ? results : [], dropped: [] };
  }
  const noiseKeywords = Array.isArray(config?.noise_keywords) ? config.noise_keywords : [];
  // [0726 算法v2] no_match 阈值可配（config.no_match_threshold，默认 0.15——cjkMatchScore 连续分）
  const _nmThr = typeof config?.no_match_threshold === "number" ? config.no_match_threshold : 0.15;
  const kept = [], dropped = [];
  for (const r of results) {
    const flag = assessNoise(r, terms, noiseKeywords, _nmThr);
    if (flag) dropped.push({ title: r?.title || "", url: r?.url || "", flag });
    else kept.push(r);
  }
  return { kept, dropped };
}

// ============================================================
// 统一入口
// ============================================================

/**
 * 执行联网搜索（通用联网套件统一入口，单一权威）
 *
 * 套件流水线：关键词优化 → 引擎检索 → 广告/噪音筛选 → 排序/去重/摘要 → 域名黑白名单过滤。
 * 引擎失败不做隐式第二引擎兜底：error 原样上行，调用方必须让失败可见（回喂 AI / 面板展示）。
 *
 * @param {string} query - 搜索关键词
 * @param {object} config - 搜索配置（键名与 storage.mjs web_search 默认表一字不差）
 * @param {string} [config.engine] - 可选值见 SUPPORTED_ENGINES/ENGINE_REGISTRY 单源（ddgs/browser/edge/
 *   bing/google/sogou 六选）| "tavily" | "searxng"（API 通道）| "multi"（默认，多平台并发）| "none"。
 *   （演进：0716 曾默认 edge → 0717 改默认 browser → 0726 改默认 multi 并发）
 * @param {string} [config.tavily_api_key] - Tavily API Key
 * @param {string} [config.searxng_url] - SearXNG 实例 URL
 * @param {number} [config.max_results=5] - 最大结果数
 * @param {number} [config.timeout_ms=8000] - 超时毫秒数
 * @param {string[]} [config.domain_whitelist] - 结果域名白名单（空=不限）
 * @param {string[]} [config.domain_blacklist] - 结果域名黑名单（命中即滤）
 * @param {boolean} [config.noise_filter=true] - 广告/噪音筛选开关
 * @param {string[]} [config.noise_keywords] - 内容噪音词表（用户数据层，代码不内置）
 * @param {string} [config.mode] - "browse" 进入模拟真人浏览（占位，见 browseAsHuman）
 * @param {boolean} [config.optimize_query=true] - 是否启用关键词优化（默认开）
 * @returns {Promise<{results: SearchResult[], error: string|null, engine: string,
 *   noise_dropped?: Array<{title:string,url:string,flag:string}>}>}
 */
export async function executeWebSearch(query, config) {
  let engine = config?.engine || DEFAULT_ENGINE;

  // ⑤ 模拟真人浏览：mode=browse 时走占位接口（分身专项驱动，待决）
  if (config?.mode === "browse") {
    return browseAsHuman(query, config);
  }

  if (engine === "none") {
    return {
      results: [],
      error: "搜索已禁用（engine = none）",
      engine: "none",
    };
  }

  // 存量配置里可能残留已移除的引擎值（如 duckduckgo）——归一化到默认并留痕，不让搜索直接死
  // （值域=注册表键存在性，与下拉/probe/分派同一单源）
  // 存量配置升级（见 _upgradeLegacyEngine）：老 _config.json 里的旧出厂默认在此提升为 multi，
  //   否则所有老角色卡永远走不到多平台并发（storage 默认表只影响新建配置）
  engine = _upgradeLegacyEngine(config, engine);

  // "multi"=并发多平台（0726 默认），它不是注册表成员而是**调度模式**，故先于注册表校验放行
  if (engine !== "multi" && !ENGINE_REGISTRY[engine]) {
    console.warn(`[webSearch] 引擎 "${engine}" 不在注册表，归一化为 ${DEFAULT_ENGINE}`);
    engine = DEFAULT_ENGINE;
  }
  const _engineSpec = ENGINE_REGISTRY[engine]; // multi 时为 undefined，仅单引擎路径消费

  if (!query || !query.trim()) {
    return { results: [], error: "搜索关键词为空", engine };
  }

  // ① 套件层：搜索前关键词优化（查询改写/拆关键词）。可被 config.optimize_query=false 关闭。
  const _opt = config?.optimize_query === false
    ? { query: query.trim(), terms: [], orGroups: [] }
    : optimizeQuery(query);
  const _effectiveQuery = _opt.query || query.trim();

  // 代理 fetch（用户配 proxy_url 时生效；Clash TUN 全局接管环境下无需此项，面向纯 env 代理用户）
  const _pFetch = _makeProxiedFetch(config?.proxy_url);

  try {
    // ⓪ [0726 002「一次性多个平台…速度和质量都有了」] 多平台并发
    //   why 取代原"单引擎 + 失败串行降级"：
    //     速度——串行降级把各引擎耗时**累加**（实测 bing 超时 26s 后才轮到下一个）；并发的总耗时
    //           等于最慢的那个、且有整体时间窗封顶，快的引擎先回来就够用。
    //     容错——一个平台被拒/限流/挂死不再拖垮整轮，其余平台的结果照常返回（无需探测预判）。
    //     质量——rankAndDedupe 的 `consensus`（多引擎共识）权重此前是**死信号**（一次只有一个引擎
    //           的结果，无从共识）；并发后同一条 URL 被多个平台命中即自动加权，这是白捡的质量提升。
    //   时间窗：窗口内回来的都用，未回来的丢弃（不等）——保证"多平台"不以牺牲速度为代价。
    //   单引擎显式指定（engine=具体值且未开 multi）时走原路径，排查/兼容不受影响。
    const _engineList = _resolveEngineList(config, engine);
    const _multi = _engineList.length > 1;

    if (!_multi) {
      // 单引擎路径保留可达性探测（并发路径不探测：探测本身要 2-4s，与"快"直接冲突，
      // 且并发下某引擎不可达由其余引擎兜底，探测的 fail-fast 价值消失）
      const _probeHost = typeof _engineSpec.probeHost === "function" ? _engineSpec.probeHost(config) : _engineSpec.probeHost;
      if (_probeHost) {
        // [0726 proxy断链修] 探测与真实请求同走 _pFetch 通道（配了代理时用裸 fetch 探测=测错通道误杀）
        try { await probeReachable(_probeHost, 2000, _pFetch); }
        catch {
          await new Promise((r) => setTimeout(r, 500));
          try { await probeReachable(_probeHost, 2000, _pFetch); }
          catch (probeErr) { return { results: [], error: probeErr.message, engine, noise_dropped: [] }; }
        }
      }
    }

    // [0716 网络波动容错·凛倾指令] 引擎调用瞬态失败重试：原单次尝试，超时/连接重置一次即整轮报废。
    //   瞬态判据与 proxy httpFetch 同口径（超时/AbortError/连接类错误），非瞬态（HTTP 4xx/解析错）不重试。
    //   ⚠ 仅单引擎路径重试：并发路径下"重试"由其他平台天然承担，再叠重试只会拖长时间窗。
    const _runOne = async (engKey, allowRetry) => {
      const spec = ENGINE_REGISTRY[engKey];
      const call = () => spec.run(_effectiveQuery, config, _pFetch); // 分派=注册表 run 声明；[0726] _pFetch 真传入（此前零消费=proxy_url 对 fetch 引擎断链）
      try {
        return await call();
      } catch (e1) {
        const _eAll = `${e1.message || ""} ${e1.cause?.message || ""}`;
        const _transient = e1.name === "AbortError" || /超时|timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|terminated|other side closed|reading a body/i.test(_eAll);
        if (!allowRetry || !_transient) throw e1;
        console.warn(`[webSearch] 瞬态失败，1s 后重试一次 (${engKey}): ${e1.message}`);
        await new Promise((r) => setTimeout(r, 1000));
        return await call();
      }
    };

    let results;
    const _engineErrors = [];   // 部分失败留痕（诊断可见，不折叠成静默）
    const _enginesUsed = [];    // 实际有结果的平台（上行 engine 字段用）
    if (!_multi) {
      results = await _runOne(engine, true);
      _enginesUsed.push(engine);
    } else {
      const _budget = Math.max(1500, Number(config?.multi_window_ms) || 5000);
      const _deadline = new Promise((resolve) => setTimeout(() => resolve("__WINDOW__"), _budget));
      const settled = await Promise.all(_engineList.map(async (k) => {
        try {
          const r = await Promise.race([_runOne(k, false), _deadline]);
          if (r === "__WINDOW__") { _engineErrors.push(`${k}: 超出时间窗 ${_budget}ms`); return []; }
          const arr = Array.isArray(r) ? r : [];
          if (arr.length > 0) _enginesUsed.push(k);
          else _engineErrors.push(`${k}: 无结果`);
          return arr;
        } catch (e) {
          _engineErrors.push(`${k}: ${String(e?.message || e).slice(0, 120)}`);
          return [];
        }
      }));
      results = settled.flat();
      diag.log(`[webSearch] 多平台并发 ${_engineList.length} 个：成功 ${_enginesUsed.join("/") || "无"}，合计 ${results.length} 条${_engineErrors.length ? "；失败 " + _engineErrors.join(" | ") : ""}`);
      // 全部平台皆无结果=真失败，把每个平台的原因原样上行（AI/用户可判是网络、依赖缺失还是被拒）
      if (results.length === 0) {
        return { results: [], error: `全部 ${_engineList.length} 个搜索平台均无结果——${_engineErrors.join(" | ")}`, engine: _engineList.join("+"), noise_dropped: [] };
      }
      engine = _enginesUsed.join("+"); // 上行 engine=实际生效平台（诊断/前端卡头可辨）
    }

    // ① 广告/噪音筛选（先于去重：广告不参与多引擎共识计数）；被滤条目留痕上行
    const { kept: _clean, dropped: _noise } = filterNoise(results, _opt.terms, config);
    if (_noise.length > 0) {
      diag.log(`[webSearch] 噪音筛除 ${_noise.length} 条: ${_noise.map((d) => `${d.flag}:${d.url || d.title}`).join(" | ")}`);
    }
    // ①b 软拦截确诊（0717 实证：bing 对低信任请求返回与查询完全无关的投毒填充页，
    //   引擎"成功"返回 N 条但 no_match 全灭）——这是引擎级故障不是"真无结果"，
    //   error 明示上行让 AI/用户看到真因，不再折叠成静默空结果。
    // [0726 算法v2] 软拦截去二值化：原"全灭且 no_match≥半数"一刀切 → 连续可疑度分级。
    //   suspicion = no_match 占比（cjkMatchScore 连续分判定后的 no_match 已远比整串 includes 可靠）。
    //   ≥高阈(默认0.8)→报投毒；[中阈,高阈)→放行但 error 字段带"部分可疑"警示（结果照注入，AI 自判）；
    //   <中阈→放行。阈值可配 poison_threshold/poison_warn_threshold。
    let _poisonWarn = null;
    if (results.length > 0) {
      const _nmCount = _noise.filter((d) => d.flag === "no_match").length;
      const _suspicion = _nmCount / results.length;
      const _thrHigh = typeof config?.poison_threshold === "number" ? config.poison_threshold : 0.8;
      const _thrWarn = typeof config?.poison_warn_threshold === "number" ? config.poison_warn_threshold : 0.5;
      if (_clean.length === 0 && _suspicion >= _thrHigh) {
        return {
          results: [], engine, noise_dropped: _noise,
          error: `引擎返回 ${results.length} 条结果但 ${Math.round(_suspicion * 100)}% 与查询无关——疑似被搜索引擎软拦截/投毒，建议改用 browser 引擎或检查代理出口`,
        };
      }
      if (_suspicion >= _thrWarn) {
        _poisonWarn = `注意：本次结果中 ${_nmCount}/${results.length} 条与查询相关度极低（已过滤），剩余结果可信度请自判`;
      }
    }
    // ② 多结果算法排序 + 去重（本地启发式，无外部付费依赖）
    const _ranked = rankAndDedupe(_clean, _opt.terms, config);
    // ③ 域名黑白名单过滤（白名单空=不限；Tavily AI 摘要无 URL，保留不受名单影响）
    const _filtered = _ranked.filter((r) => !r.url || isDomainAllowed(r.url, config));
    // ④ 域名多样性截断（对标多样化结果面：单站最多 domain_cap 条，防模板站/内容农场刷屏；
    //   0=不限。超出部分非丢弃语义上等同排序末位淘汰，留痕进 noise_dropped 供诊断）
    const _cap = Number.isInteger(config?.domain_cap) ? config.domain_cap : 2;
    let _diverse = _filtered;
    if (_cap > 0) {
      const _perHost = new Map();
      _diverse = [];
      for (const r of _filtered) {
        const h = _hostOf(r.url || "");
        const n = (_perHost.get(h) || 0) + 1;
        _perHost.set(h, n);
        if (!h || n <= _cap) _diverse.push(r);
        else _noise.push({ title: r.title || "", url: r.url || "", flag: "domain_cap" });
      }
    }
    // ⑥ 平台路由钩子（beilu-reach）：query 含 site:已知平台域名时，
    //   通过 dispatch 调 functions:reach 补充结构化平台数据，混入通用搜索结果前部。
    //   钩子失败不影响通用搜索结果（增强层，非依赖层）。
    try {
      const _platformAugmented = await _platformRouteHook(_effectiveQuery, _diverse);
      if (_platformAugmented) _diverse = _platformAugmented;
    } catch (hookErr) {
      diag.log(`[webSearch] 平台路由钩子异常（不影响通用结果）: ${hookErr.message}`);
    }

    // ⑥b [0726 002「正文用关键词看正文内容匹配」] 正文校验：并发抓 top-N 正文，按查询词打分重排。
    //   放在排序/过滤之后=只对最终会喂给 AI 的少数条目付出抓取成本（放前面要抓几十条，与"快"冲突）；
    //   放在净化之前=抓回来的正文摘录同样过 ⑦ 的中性化，不绕过安全层。
    if (config?.content_verify !== false) {
      _diverse = await verifyByContent(_diverse, query, _opt.terms, config, _pFetch);
    }

    // ⑦ [0726 注入防御口径对齐] 外部字段中性化收口（SEC-T8 _sanitizeField 单源：不可见 Unicode 剥除
    //   + 尖括号全角化）。**必须在返回之前、所有消费方之前**。
    //   why 补这一步：此前只有 reach 平台结果过了 _sanitizeField（:1190），通用引擎结果（bing/browser/
    //   sogou/tavily…）**零中性化**——同一个 results 数组里两种口径，恶意网页标题/摘要里的
    //   ＜ideToolCall＞ 等协议标签可原样进 AI 上下文（OWASP LLM01 间接注入）。
    //   why 放收口不放各引擎解析处：5 个消费入口（chat/分身/P8/P1/beilu-web ＜search＞）全部经由本函数
    //   返回，一处即全覆盖；放引擎侧要改 6 处且每新增引擎必漏一次。
    //   与 P8 的 wrapUntrusted 是两层不同职责：此处=字段级中性化（内容形态），那里=边界标注（nonce
    //   包裹声明"仅作资料"）。两层叠加幂等无害（已全角的字符不会二次变换）。
    for (const _r of _diverse) {
      if (!_r || typeof _r !== "object") continue;
      _r.title = _sanitizeField(_r.title || "");
      _r.snippet = _sanitizeField(_r.snippet || "");
    }

    // [0726 算法v2·警示字段分离修] 中等可疑度=成功但带警示：**独立 warning 字段**，不复用 error。
    //   为什么不用 error：四入口对成功/失败的判据不统一（chat 判 results.length、分身判 !error、
    //   P8 判 if(error) 先行、beilu-web 只读 results）——把警示塞进 error 会让"判 error"的两个入口
    //   把带警示的成功当失败、连带丢弃非空结果（0726 四链审计实证）。契约收窄为：
    //   **error 非空 ⇔ 本次搜索失败且 results 必空**（历史语义不变，所有入口零改动即安全）；
    //   warning 非空 = 成功但需提醒，消费方按需读取（未读取=行为与改动前完全一致）。
    return { results: _diverse, error: null, warning: _poisonWarn, engine, noise_dropped: _noise };
  } catch (e) {
    console.error(`[webSearch] 搜索失败 (${engine}):`, e.message);
    return { results: [], error: e.message, engine };
  }
}

/**
 * 平台路由钩子：当搜索 query 含 site:已知平台域名时，
 * 通过 dispatch 调 functions:reach 获取结构化平台数据，混入通用结果前部。
 * @param {string} query - 优化后的搜索查询
 * @param {SearchResult[]} generalResults - 通用搜索结果
 * @returns {Promise<SearchResult[]|null>} 混合结果，或 null（无平台匹配）
 */
async function _platformRouteHook(query, generalResults) {
  // 开关门控：用户在平台触达面板关掉 enabled/platformRoute 时钩子整体退出
  //（此前开关只存配置无人消费=死配置，关了照样路由）
  try {
    const { getReachConfig } = await import("../reach/config.mjs");
    const _rcfg = getReachConfig();
    if (!_rcfg.enabled || !_rcfg.platformRoute) return null;
  } catch { return null; }

  let _detectPlatformHint, _stripSitePrefix;
  try {
    const mod = await import("../reach/registry.mjs");
    _detectPlatformHint = mod.detectPlatformHint;
    _stripSitePrefix = mod.stripSitePrefix;
  } catch { return null; }

  const platform = _detectPlatformHint(query);
  if (!platform) return null;

  let dispatch;
  try {
    const dMod = await import("../../dispatch/dispatcher.mjs");
    dispatch = dMod.dispatch;
  } catch { return null; }

  const strippedQuery = _stripSitePrefix(query);
  const r = await dispatch({
    verb: "search",
    target: "functions:reach",
    payload: { platform, query: strippedQuery, limit: 5 },
  });

  if (!r?.ok || !r.data) return null;

  // 将平台结果归一化为 SearchResult 格式
  const platformResults = _normalizePlatformResults(r.data, platform);
  if (platformResults.length === 0) return null;

  return [...platformResults, ...generalResults];
}

function _normalizePlatformResults(data, platform) {
  if (!data) return [];
  const items = Array.isArray(data) ? data : [data];
  return items.slice(0, 5).map((item) => ({
    // [SEC 安全同步 0722] 平台内容=不可信外部文本，混入搜索结果前逐字段中性化
    //（尖括号全角+不可见 Unicode 剥除），防经搜索结果注入链重建协议标签（OWASP LLM01）
    title: _sanitizeField(item.title || item.name || item.symbol || String(item.id || "")),
    url: item.url || item.link || item.arcurl || "",
    snippet: _sanitizeField(item.content || item.description || item.desc || item.text || ""),
    source: `reach:${platform}`,
  })).filter((r) => r.title);
}

function _sanitizeField(s) {
  return neutralizeAngleBrackets(stripInvisibleUnicode(s));
}

/**
 * 将搜索结果格式化为 AI 可读的文本
 * @param {SearchResult[]} results
 * @returns {string}
 */
export function formatSearchResultsForP8(results) {
  if (!results || results.length === 0) {
    return "(搜索无结果)";
  }

  return results
    .map((r, i) => {
      const parts = [`[${i + 1}] ${r.title}`];
      if (r.url) parts.push(`链接: ${r.url}`);
      if (r.snippet) parts.push(`摘要: ${r.snippet}`);
      if (r.source) parts.push(`来源: ${r.source}`);
      // [0726] 相关度双源：引擎自带分（tavily/searxng）与本地融合分（rankAndDedupe.relevance，全引擎都有）
      //   都打印——P8 据此判断"这批结果值不值得用"、哪几条占比高，而不是只能看排序次序。
      if (r.score !== undefined && r.score > 0)
        parts.push(`引擎相关度: ${(r.score * 100).toFixed(0)}%`);
      if (r.relevance !== undefined && r.relevance > 0)
        parts.push(`综合相关度: ${(r.relevance * 100).toFixed(0)}%`);
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

/**
 * 结果 → 可直接注入 AI 上下文的安全文本（**功能层单一出口**）。
 *
 * 【why 这个函数必须存在于功能层·「底部功能层.txt」第 44 行「功能层是一个，单次传导/缓存/处理是 3 个+n」】
 *   联网整域（第 4 行「联网功能:p8」）归功能层单份持有；chat / 分身 / P8 是三条**传导链**，
 *   职责只是搬运，不该各自持有"怎么把结果变成给 AI 看的文本"这一功能。
 *   改前的实态正是散写三份：三条链各写一套编号格式（`1.` / `[1]` 两种）、各自决定要不要打印
 *   relevance（分身链**没有**→002「看占比」在该链缺席）、各自决定要不要过安全边界（0726 前
 *   只有 P8 过 wrapUntrusted，chat/分身零包裹）。同一功能三处实现 = 每次改动必漏一处。
 *   收口后：格式、相关度、安全边界三件事只在这里定义一次，新增消费链零遗漏、零重复。
 *
 * 【安全分层】字段级中性化已在 executeWebSearch ⑦ 做（内容形态）；此处做**边界层**——
 *   wrapUntrusted 的随机 nonce 让外部内容无法伪造闭合标记冒充系统发言（SEC-T8 原语单源）。
 *   两层职责不同、叠加幂等。
 *
 * @param {SearchResult[]} results
 * @param {string} sourceTag - 来源标识（进边界标注，仅可读性用途，如 "聊天AI联网搜索"/"分身联网搜索"/"P8联网搜索"）
 * @returns {string} 已过安全边界、可直接拼进上下文的文本
 */
export function buildInjectableSearchText(results, sourceTag) {
  const body = formatSearchResultsForP8(results);
  if (!results || results.length === 0) return body; // 无结果=本系统文案，不需要不可信边界
  return wrapUntrusted(body, sourceTag);
}

/**
 * 联网功能全链路诊断 — 逐节点检查，返回结构化报告供前端渲染。
 * 节点：配置读取 → 引擎可达性 → 测试搜索 → 噪音过滤 → Playwright 状态
 * @param {object} config - web_search 配置（从 beilu-memory _config.json 读取的同一份）
 * @returns {Promise<{nodes: Array<{id:string, name:string, ok:boolean, ms:number, detail:string}>}>}
 */
export async function diagnoseWebSearch(config) {
  const nodes = [];
  const _node = (id, name, ok, ms, detail) => nodes.push({ id, name, ok, ms, detail });

  // N1: 配置完整性
  const engine = config?.engine || "(未设)";
  const mode = config?.mode || "(未设)";
  const hasKey = !!(config?.tavily_api_key);
  _node("config", "配置", true, 0,
    `引擎=${engine} 模式=${mode} 结果数=${config?.max_results ?? "?"} 超时=${config?.timeout_ms ?? "?"}ms` +
    (hasKey ? " Tavily=有key" : "") +
    (config?.proxy_url ? ` 代理=${config.proxy_url}` : ""));

  // N2: 引擎可达性探测（目标=注册表 probeHost 声明；null=刻意不探测——browser 走浏览器
  //   网络栈≠fetch 栈用 fetch 探测=用错栈误判，其连通性由 N3 测试搜索真实验证）
  const _diagSpec = ENGINE_REGISTRY[engine] || null;
  const host = _diagSpec ? (typeof _diagSpec.probeHost === "function" ? _diagSpec.probeHost(config) : _diagSpec.probeHost) : null;
  if (host) {
    const t0 = Date.now();
    try {
      await probeReachable(host, 3000);
      _node("probe", `可达性 (${host})`, true, Date.now() - t0, "HEAD 请求通过");
    } catch (e) {
      _node("probe", `可达性 (${host})`, false, Date.now() - t0, e.message);
    }
  } else {
    _node("probe", "可达性", true, 0, `引擎 ${engine} 无需 fetch 探测（浏览器通道/用户自配/未设）`);
  }

  // N3: 测试搜索
  const testQuery = "test";
  const t1 = Date.now();
  const result = await executeWebSearch(testQuery, { ...config, max_results: 3, timeout_ms: 6000 });
  const searchMs = Date.now() - t1;
  if (result.error) {
    _node("search", "测试搜索", false, searchMs, `${result.engine}: ${result.error}`);
  } else {
    const titles = (result.results || []).slice(0, 3).map((r, i) => `  [${i + 1}] ${(r.title || "").slice(0, 40)}`).join("\n");
    _node("search", "测试搜索", true, searchMs,
      `${result.engine}: ${result.results?.length || 0} 条结果` +
      (result.noise_dropped?.length ? ` (筛除${result.noise_dropped.length}条噪音)` : "") +
      (titles ? "\n" + titles : ""));
  }

  // N4: Playwright（爬取能力，browse 域）
  try {
    const { probeCrawlCapability } = await import("./crawlProbe.mjs");
    const crawl = probeCrawlCapability(config?.browsers_path);
    _node("playwright", "浏览器爬取", crawl.available, 0, crawl.summary);
  } catch (e) {
    _node("playwright", "浏览器爬取", false, 0, e.message);
  }

  // N5: browser 引擎内核（搜索主通道，executablePath 直连——与 N4 包级判定互补）
  try {
    const exe = findChromiumExecutable(config?.browsers_path);
    _node("browser_kernel", "浏览器搜索内核", !!exe, 0,
      exe ? `内核: ${exe}` : "未找到 Chromium 内核（browsers_path / 项目根 browsers / 系统 ms-playwright 均无）");
  } catch (e) {
    _node("browser_kernel", "浏览器搜索内核", false, 0, e.message);
  }

  return { nodes };
}
