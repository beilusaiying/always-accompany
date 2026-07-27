/**
 * xiaohongshu.mjs — 小红书平台适配器（CLI 桥接）
 *
 * 后端优先级：opencli > mcporter(xiaohongshu-mcp)
 * 注意：读笔记必须用含 xsec_token 的完整 URL（先搜索拿 URL 再读）。
 */

import { execCLI, probeCommand } from "../bridge.mjs";

async function _detectBackend() {
  if ((await probeCommand("opencli", ["--version"])).status === "ok") return "opencli";
  if ((await probeCommand("mcporter", ["--version"])).status === "ok") return "mcporter";
  return null;
}

const _opencli = {
  search: (q) => execCLI("opencli", ["xiaohongshu", "search", q, "-f", "yaml"], { parseAs: "text" }),
  note: (url) => execCLI("opencli", ["xiaohongshu", "note", url, "-f", "yaml"], { parseAs: "text" }),
  comments: (id) => execCLI("opencli", ["xiaohongshu", "comments", id, "-f", "yaml"], { parseAs: "text" }),
  feed: () => execCLI("opencli", ["xiaohongshu", "feed", "-f", "yaml"], { parseAs: "text" }),
};

const _mcporter = {
  search: (q) => execCLI("mcporter", ["call", `xiaohongshu.search_feeds(keyword: "${q}")`, "--timeout", "120000"], { parseAs: "text", timeout: 130000 }),
  note: (url) => {
    const m = url.match(/\/([a-f0-9]{24})/);
    const id = m ? m[1] : url;
    return execCLI("mcporter", ["call", `xiaohongshu.get_feed_detail(feed_id: "${id}")`, "--timeout", "120000"], { parseAs: "text", timeout: 130000 });
  },
  comments: () => ({ ok: false, stderr: "mcporter backend does not support comments" }),
  feed: () => execCLI("mcporter", ["call", "xiaohongshu.get_hot_feeds()", "--timeout", "120000"], { parseAs: "text", timeout: 130000 }),
};

export default {
  name: "xiaohongshu",
  async execute(action, query, opts) {
    const backend = await _detectBackend();
    if (!backend) throw new Error("xiaohongshu: no backend available (install opencli or mcporter + xiaohongshu-mcp)");
    const impl = backend === "opencli" ? _opencli : _mcporter;
    const fn = impl[action];
    if (!fn) throw new Error(`xiaohongshu: unknown action "${action}". Available: search, note, comments, feed`);
    const result = await fn(query, opts);
    if (!result.ok) throw new Error(`xiaohongshu/${backend}: ${result.stderr || "command failed"}`);
    return result.data;
  },
};
