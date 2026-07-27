/**
 * registry.mjs — 平台注册表
 *
 * 每个平台声明能力、后端候选、可用性探测。
 * 适配器按需惰性加载（首次 execute 时 import）。
 *
 * 【功能链】
 *   本表 → doctor.mjs 遍历探测 → main.mjs GetPrompt 读可用列表 → ReplyHandler 路由到适配器
 *   本表 → executeWebSearch 平台路由钩子按 domains 匹配
 *   本表 fromUrl → web/main.mjs fetchWebPage URL 智能提取（URL→该平台真实 action+query；
 *   无 fromUrl 的平台不参与 URL 提取，诚实降级到通用抓取——此前钩子固定 action:'read'，
 *   多数平台无 read action 必抛，URL 提取形同虚设）
 */

import { probeCommand } from "./bridge.mjs";

/**
 * @typedef {Object} PlatformEntry
 * @property {string} label - 人类可读名
 * @property {string[]} actions - 支持的操作（search/read/video/hot/...）
 * @property {string[]} backends - 有序候选后端
 * @property {number} tier - 0=零配置 1=需登录 2=复杂设置
 * @property {string[]} domains - URL 路由匹配域名
 * @property {() => Promise<object>} probe - 可用性探测
 * @property {string} module - 适配器模块路径（相对于 adapters/）
 * @property {(url:string) => {action:string, query:string}|null} [fromUrl] - URL→操作映射（URL 智能提取入口；缺省=不参与）
 * @property {Array<{key:string,label:string,desc:string,type:string,placeholder?:string}>} [credentials]
 *   - 凭据控件声明（凛倾 0722 禁前端硬编码：前端凭据区按此渲染，零逐平台手写区块）
 * @property {string} [credentialHelp] - 凭据获取分步引导（多行文案，前端「如何获取?」折叠块正文）
 */

/** @type {Record<string, PlatformEntry>} */
export const PLATFORM_REGISTRY = {
  v2ex: {
    label: "V2EX",
    actions: ["hot", "node", "topic", "user"],
    backends: ["native"],
    tier: 0,
    domains: ["v2ex.com"],
    probe: () => Promise.resolve({ status: "ok" }),
    module: "./adapters/v2ex.mjs",
    fromUrl: (url) => { const m = url.match(/\/t\/(\d+)/); return m ? { action: "topic", query: m[1] } : null; },
  },
  github: {
    label: "GitHub",
    actions: ["search-repos", "search-code", "repo", "issues", "prs"],
    backends: ["gh-cli"],
    tier: 0,
    domains: ["github.com"],
    probe: () => probeCommand("gh", ["--version"]),
    module: "./adapters/github.mjs",
    fromUrl: (url) => { const m = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/); return m ? { action: "repo", query: `${m[1]}/${m[2]}` } : null; },
    credentials: [
      { key: "githubToken", label: "GitHub Token", desc: "可选 · 无 token: 60 次/h · 有 token: 5000 次/h", type: "password" },
    ],
    credentialHelp: "1. 登录 GitHub → 打开 github.com/settings/tokens\n2. 点「Generate new token (classic)」\n3. 权限勾选：一个都不用勾（只读公开数据无需任何权限）\n4. 生成后复制以 ghp_ 开头的字符串粘贴到上方（页面只显示一次，请当场复制）",
  },
  youtube: {
    label: "YouTube",
    actions: ["info", "subtitle", "search"],
    backends: ["yt-dlp"],
    tier: 0,
    domains: ["youtube.com", "youtu.be"],
    probe: () => probeCommand("yt-dlp", ["--version"]),
    module: "./adapters/youtube.mjs",
    fromUrl: (url) => ({ action: "info", query: url }), // yt-dlp 直接接受完整 URL
    credentials: [
      { key: "ytCookiesFrom", label: "Cookie 来源浏览器", desc: "yt-dlp 从该浏览器读取 Cookie（年龄限制/会员视频）", type: "text", placeholder: "chrome / firefox / edge" },
    ],
    credentialHelp: "这一项不需要手动复制 Cookie：\n填浏览器名字即可（chrome / firefox / edge），前提是该浏览器登录过 YouTube。\nyt-dlp 会自动从该浏览器读取登录态。只看公开视频可留空。",
  },
  rss: {
    label: "RSS/Atom",
    actions: ["read"],
    backends: ["native"],
    tier: 0,
    domains: [],
    probe: () => Promise.resolve({ status: "ok" }),
    module: "./adapters/rss.mjs",
  },
  jina: {
    label: "Jina Reader",
    actions: ["read"],
    backends: ["native"],
    tier: 0,
    domains: [],
    probe: () => Promise.resolve({ status: "ok" }),
    module: "./adapters/jina.mjs",
  },
  twitter: {
    label: "Twitter/X",
    actions: ["search", "read", "user", "feed"],
    backends: ["twitter-cli", "opencli"],
    tier: 1,
    domains: ["twitter.com", "x.com"],
    probe: () => probeCommand("twitter", ["--version"]),
    module: "./adapters/twitter.mjs",
    fromUrl: (url) => { const m = url.match(/\/status\/(\d+)/); return m ? { action: "read", query: m[1] } : null; },
    credentials: [
      { key: "twitterAuthToken", label: "auth_token", desc: "浏览器 Cookie 中的 auth_token 值", type: "password" },
      { key: "twitterCt0", label: "ct0", desc: "浏览器 Cookie 中的 ct0 值（CSRF token）", type: "password" },
    ],
    credentialHelp: "1. 在浏览器登录 x.com（推特）\n2. 按 F12 打开开发者工具 → 顶部选「应用/Application」标签\n3. 左侧「Cookie」→ 点 https://x.com\n4. 在列表里找到 auth_token，双击「值」一列复制，粘贴到上方第一格\n5. 同样找到 ct0，复制粘贴到第二格",
  },
  bilibili: {
    label: "Bilibili",
    actions: ["search", "video", "hot", "rank"],
    backends: ["bili-cli", "opencli"],
    tier: 0,
    domains: ["bilibili.com", "b23.tv"],
    probe: () => probeCommand("bili", ["--version"]),
    module: "./adapters/bilibili.mjs",
    fromUrl: (url) => { const m = url.match(/\/video\/(BV\w+)/); return m ? { action: "video", query: m[1] } : null; },
    credentials: [
      { key: "biliSessdata", label: "SESSDATA", desc: "浏览器 Cookie 中的 SESSDATA 值（可选，只读场景不需要）", type: "password" },
      { key: "biliCsrf", label: "bili_jct (CSRF)", desc: "浏览器 Cookie 中的 bili_jct 值", type: "password" },
    ],
    credentialHelp: "1. 在浏览器登录 bilibili.com\n2. 按 F12 → 「应用/Application」→ 左侧「Cookie」→ 点 https://www.bilibili.com\n3. 找到 SESSDATA，双击「值」复制到上方第一格\n4. 需要更高权限时再找 bili_jct 复制到第二格（只查视频/热门可不填）",
  },
  reddit: {
    label: "Reddit",
    actions: ["search", "read", "subreddit", "hot"],
    backends: ["opencli", "rdt-cli"],
    tier: 1,
    domains: ["reddit.com"],
    probe: () => probeCommand("opencli", ["--version"]),
    module: "./adapters/reddit.mjs",
  },
  xiaohongshu: {
    label: "小红书",
    actions: ["search", "note", "comments", "feed"],
    backends: ["opencli", "mcporter"],
    tier: 1,
    domains: ["xiaohongshu.com", "xhslink.com"],
    probe: () => probeCommand("opencli", ["--version"]),
    module: "./adapters/xiaohongshu.mjs",
    fromUrl: (url) => ({ action: "note", query: url }), // 读笔记必须用含 xsec_token 的完整 URL
    credentials: [
      { key: "xhsCookie", label: "Cookie 字符串", desc: "浏览器完整 Cookie 头（从 DevTools 复制）", type: "password" },
    ],
    credentialHelp: "这一项要的是整行 Cookie（不是单个值）：\n1. 在浏览器登录 xiaohongshu.com\n2. 按 F12 → 「网络/Network」标签 → 刷新页面\n3. 点列表里任意一个 xiaohongshu.com 的请求\n4. 在「请求标头/Request Headers」里找到 Cookie: 开头的一行\n5. 复制冒号后面的整段内容，粘贴到上方",
  },
  xueqiu: {
    label: "雪球",
    actions: ["quote", "search-stock", "hot-posts", "hot-stocks"],
    backends: ["native"],
    tier: 1,
    domains: ["xueqiu.com"],
    probe: () => Promise.resolve({ status: "ok" }),
    module: "./adapters/xueqiu.mjs",
    fromUrl: (url) => { const m = url.match(/\/S\/([A-Za-z0-9.]+)/); return m ? { action: "quote", query: m[1] } : null; },
    credentials: [
      { key: "xueqiuCookie", label: "Cookie 字符串", desc: "需含 xq_a_token（从浏览器 DevTools 复制）", type: "password" },
    ],
    credentialHelp: "这一项要的是整行 Cookie（不是单个值）：\n1. 在浏览器登录 xueqiu.com（雪球）\n2. 按 F12 → 「网络/Network」标签 → 刷新页面\n3. 点列表里任意一个 xueqiu.com 的请求\n4. 在「请求标头/Request Headers」里找到 Cookie: 开头的一行\n5. 复制冒号后面的整段内容（里面应包含 xq_a_token=...），粘贴到上方",
  },
  facebook: {
    label: "Facebook",
    actions: ["search", "profile", "feed"],
    backends: ["opencli"],
    tier: 1,
    domains: ["facebook.com"],
    probe: () => probeCommand("opencli", ["--version"]),
    module: "./adapters/facebook.mjs",
  },
  instagram: {
    label: "Instagram",
    actions: ["search", "profile", "user", "explore"],
    backends: ["opencli"],
    tier: 2,
    domains: ["instagram.com"],
    probe: () => probeCommand("opencli", ["--version"]),
    module: "./adapters/instagram.mjs",
  },
  linkedin: {
    label: "LinkedIn",
    actions: ["profile", "search-people", "search-jobs", "company"],
    backends: ["mcporter", "jina"],
    tier: 2,
    domains: ["linkedin.com"],
    probe: () => probeCommand("mcporter", ["--version"]),
    module: "./adapters/linkedin.mjs",
    fromUrl: (url) => ({ action: "profile", query: url }), // mcporter/jina 后端均直接接受完整 URL
  },
};

/** 按 URL 域名匹配平台 */
export function matchPlatformByDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    for (const [name, entry] of Object.entries(PLATFORM_REGISTRY)) {
      if (entry.domains.some((d) => hostname === d || hostname.endsWith("." + d))) {
        return name;
      }
    }
  } catch {}
  return null;
}

/** 从搜索 query 中提取 site:xxx 平台提示 */
export function detectPlatformHint(query) {
  const m = query.match(/site:([^\s]+)/i);
  if (!m) return null;
  const domain = m[1].replace(/^www\./, "");
  for (const [name, entry] of Object.entries(PLATFORM_REGISTRY)) {
    if (entry.domains.some((d) => domain === d || domain.endsWith("." + d))) {
      return name;
    }
  }
  return null;
}

/** 剥离 query 中的 site:xxx 前缀 */
export function stripSitePrefix(query) {
  return query.replace(/site:\S+\s*/gi, "").trim();
}
