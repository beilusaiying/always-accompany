/**
 * bilibili.mjs — Bilibili 平台适配器（CLI 桥接）
 *
 * 后端优先级：bili-cli > opencli > 公开 API 直连
 * 注意：禁止用 yt-dlp 读 B 站（风控 412 全面拦截）。
 */

import { execCLI, probeCommand } from "../bridge.mjs";

async function _detectBackend() {
  if ((await probeCommand("bili")).status === "ok") return "bili-cli";
  if ((await probeCommand("opencli", ["--version"])).status === "ok") return "opencli";
  return "api";
}

const _biliCli = {
  search: (q, opts) => execCLI("bili", ["search", q, "--type", "video", "-n", String(opts?.limit ?? 5)], { parseAs: "text" }),
  video: (bv) => execCLI("bili", ["video", bv], { parseAs: "text" }),
  hot: (_, opts) => execCLI("bili", ["hot", "-n", String(opts?.limit ?? 10)], { parseAs: "text" }),
  rank: (_, opts) => execCLI("bili", ["rank", "-n", String(opts?.limit ?? 10)], { parseAs: "text" }),
};

const _opencli = {
  search: (q) => execCLI("opencli", ["bilibili", "search", q, "-f", "yaml"], { parseAs: "text" }),
  video: (bv) => execCLI("opencli", ["bilibili", "video", bv, "-f", "yaml"], { parseAs: "text" }),
  hot: () => execCLI("opencli", ["bilibili", "search", "热门", "-f", "yaml"], { parseAs: "text" }),
  rank: () => execCLI("opencli", ["bilibili", "search", "排行", "-f", "yaml"], { parseAs: "text" }),
};

const BILI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** biliSessdata 接线：公开 API 带登录态 Cookie 提升可见范围（此前该配置收了没消费=死配置）。
 *  bili-cli/opencli 后端有各自登录体系，不经此透传。 */
function _apiHeaders(opts) {
  const headers = { "User-Agent": BILI_UA, Referer: "https://www.bilibili.com/" };
  if (opts?.config?.biliSessdata) headers.Cookie = `SESSDATA=${opts.config.biliSessdata}`;
  return headers;
}

const _api = {
  async search(query, opts) {
    const limit = opts?.limit ?? 5;
    const resp = await fetch(
      `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}&page=1`,
      { headers: _apiHeaders(opts), signal: AbortSignal.timeout(10000) },
    );
    if (!resp.ok) throw new Error(`Bilibili API ${resp.status}`);
    const json = await resp.json();
    const videos = (json.data?.result || []).find((r) => r.result_type === "video")?.data || [];
    return { ok: true, data: videos.slice(0, limit).map((v) => ({ title: v.title?.replace(/<[^>]+>/g, ""), bvid: v.bvid, play: v.play, author: v.author, url: v.arcurl })) };
  },
  video: () => ({ ok: false, data: null, stderr: "Direct API does not support video detail. Install bili-cli or opencli." }),
  hot: (_, opts) => _api.search("热门", opts),
  rank: (_, opts) => _api.search("排行", opts),
};

export default {
  name: "bilibili",

  async execute(action, query, opts) {
    const backend = await _detectBackend();
    const impl = backend === "bili-cli" ? _biliCli : (backend === "opencli" ? _opencli : _api);
    const fn = impl[action];
    if (!fn) throw new Error(`bilibili: unknown action "${action}". Available: search, video, hot, rank`);

    const result = await fn(query, opts);
    if (result && !result.ok) throw new Error(`bilibili/${backend}: ${result.stderr || "command failed"}`);
    return result?.data ?? result;
  },
};
