/**
 * config.mjs — reach 配置单源（内存 + data/reach-config.json 落盘）
 *
 * 【why】
 *   原配置只存 main.mjs 内存 _reachConfig：重启即丢，且 dispatch 路径（webSearch 平台路由钩子/
 *   URL 智能提取）拿不到凭据与开关——twitter/github 等需凭据平台在钩子路径必失败，
 *   enabled/platformRoute/urlSmartExtract 开关成死配置。故收口为独立单源模块：
 *   main.mjs（SetData 写入）、execute.mjs（凭据/白名单）、bridge.mjs（cliTimeout/proxyUrl）、
 *   web 钩子（开关门控）全部从这里读，读写同源。
 *
 * 【功能链】
 *   前端 extensionsPanel(_reachSyncBackend) → POST /config/setdata → main.mjs SetData
 *   → setReachConfig() 归一化 merge → 防抖落盘 data/reach-config.json（范式同 injectTexts）
 *   → 启动 import 时 readJsonSafeSync 读回（重启不丢）
 *   消费方：execute.mjs（config 透传+白名单裁决）/ bridge.mjs（默认超时+代理 env）/
 *   webSearch._platformRouteHook + web/main.mjs fetchWebPage（开关门控）/ main.mjs GetPrompt
 *
 * 【契约】
 *   - 只接受 REACH_DEFAULTS 里存在的键（概念域校验，拒脏键落盘）；_ 前缀键跳过（_action 等动作字段）。
 *   - 布尔/整数键归一化（前端 localStorage 存字符串 "true"/"30000"）。
 *   - 落盘损坏 → safeJsonIO 备份 .corrupt.bak 后此处捕获 warn，用默认值继续（读路不瘫痪）。
 */
import { readJsonSafeSync } from "../../../../scripts/safeJsonIO.mjs";

export const REACH_DEFAULTS = {
  enabled: true, platformRoute: true, urlSmartExtract: true, cliTimeout: 30000,
  proxyUrl: "", allowedPlatforms: "",
  twitterAuthToken: "", twitterCt0: "", githubToken: "",
  xueqiuCookie: "", xhsCookie: "",
  biliSessdata: "", biliCsrf: "",
  ytCookiesFrom: "",
};

const PERSIST_FILE = "data/reach-config.json"; // 相对路径锚 CWD，范式同 injectTexts/sysinfo PERSIST_FILE
const BOOL_KEYS = new Set(["enabled", "platformRoute", "urlSmartExtract"]);
const INT_KEYS = new Set(["cliTimeout"]);

function _normalize(k, v) {
  if (BOOL_KEYS.has(k)) return v === true || v === "true";
  if (INT_KEYS.has(k)) return parseInt(v, 10) || REACH_DEFAULTS[k];
  return v ?? "";
}

let _config = { ...REACH_DEFAULTS };
try {
  const saved = readJsonSafeSync(PERSIST_FILE, {});
  for (const [k, v] of Object.entries(saved)) {
    if (k in REACH_DEFAULTS) _config[k] = _normalize(k, v);
  }
} catch (e) {
  console.warn(`[reach] ${PERSIST_FILE} 损坏（已备份 .corrupt.bak，用默认值继续）:`, e?.message || e);
}

export function getReachConfig() { return _config; }

export function setReachConfig(data) {
  for (const [k, v] of Object.entries(data || {})) {
    if (k.startsWith("_")) continue;
    if (!(k in REACH_DEFAULTS)) continue;
    _config[k] = _normalize(k, v);
  }
  _persist();
  return _config;
}

let _persistTimer = null;
function _persist() {
  if (typeof Deno === "undefined") return;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    try {
      await Deno.mkdir("data", { recursive: true }).catch(() => {});
      await Deno.writeTextFile(PERSIST_FILE, JSON.stringify(_config, null, 2));
    } catch (err) {
      console.warn("[reach] 配置持久化失败:", err.message);
    }
  }, 100);
}

/** allowedPlatforms 成员判定：空串=全部允许（execute.mjs 统一裁决点，AI 标签/dispatch 两路共用） */
export function isPlatformAllowed(platform) {
  const raw = (_config.allowedPlatforms || "").trim();
  if (!raw) return true;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(platform);
}

// ============================================================
// 配置控件元数据（凛倾 0722 禁前端硬编码：默认值/限值/选项/文案单源后端，
// 前端面板纯渲染——GetData 随 config 一并下发，前端零默认值副本/零限值字面量）。
// 凭据类控件不在此表：由 registry 各平台 credentials 声明（平台域归平台）。
// ============================================================
export const REACH_CONFIG_META = [
  { key: "enabled",         group: "基础设置", type: "toggle", label: "启用平台触达",  desc: "开启后 AI 可通过 <reach> 标签获取平台数据" },
  { key: "platformRoute",   group: "基础设置", type: "toggle", label: "搜索平台路由",  desc: "搜索含 site:twitter.com 等时自动补充平台结构化结果" },
  { key: "urlSmartExtract", group: "基础设置", type: "toggle", label: "URL 智能提取",  desc: "浏览已知平台 URL 时优先用平台适配器提取结构化数据" },
  { key: "proxyUrl",        group: "网络与安全", type: "text",  label: "代理地址",      desc: "CLI 工具的网络代理（Twitter/Reddit 等可能需要）", placeholder: "http://127.0.0.1:7890" },
  { key: "cliTimeout",      group: "网络与安全", type: "range", label: "CLI 命令超时",  desc: "外部工具的最大执行时间", min: 5000, max: 120000, step: 5000, unit: "s", unitDiv: 1000 },
  { key: "allowedPlatforms", group: "网络与安全", type: "text", label: "平台白名单",    desc: "限制 AI 可使用的平台范围（留空=全部已安装平台可用）", placeholder: "v2ex,github,jina" },
];
