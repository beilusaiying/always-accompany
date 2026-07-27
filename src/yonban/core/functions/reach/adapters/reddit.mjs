/**
 * reddit.mjs — Reddit 平台适配器（CLI 桥接）
 *
 * 后端优先级：opencli > rdt-cli
 * 没有零配置路径，必须登录态。
 */

import { execCLI, probeCommand } from "../bridge.mjs";

async function _detectBackend() {
  if ((await probeCommand("opencli", ["--version"])).status === "ok") return "opencli";
  if ((await probeCommand("rdt")).status === "ok") return "rdt-cli";
  return null;
}

const _opencli = {
  search: (q) => execCLI("opencli", ["reddit", "search", q, "-f", "yaml"], { parseAs: "text" }),
  read: (id) => execCLI("opencli", ["reddit", "read", id, "-f", "yaml"], { parseAs: "text" }),
  subreddit: (name) => execCLI("opencli", ["reddit", "subreddit", name, "-f", "yaml"], { parseAs: "text" }),
  hot: () => execCLI("opencli", ["reddit", "hot", "-f", "yaml"], { parseAs: "text" }),
};

const _rdt = {
  search: (q, opts) => execCLI("rdt", ["search", q, "--limit", String(opts?.limit ?? 10)], { parseAs: "text" }),
  read: (id) => execCLI("rdt", ["read", id], { parseAs: "text" }),
  subreddit: (name, opts) => execCLI("rdt", ["sub", name, "--limit", String(opts?.limit ?? 20)], { parseAs: "text" }),
  hot: (_, opts) => execCLI("rdt", ["popular", "--limit", String(opts?.limit ?? 10)], { parseAs: "text" }),
};

export default {
  name: "reddit",
  async execute(action, query, opts) {
    const backend = await _detectBackend();
    if (!backend) throw new Error("reddit: no backend available (install opencli or rdt-cli)");
    const impl = backend === "opencli" ? _opencli : _rdt;
    const fn = impl[action];
    if (!fn) throw new Error(`reddit: unknown action "${action}". Available: search, read, subreddit, hot`);
    const result = await fn(query, opts);
    if (!result.ok) throw new Error(`reddit/${backend}: ${result.stderr || "command failed"}`);
    return result.data;
  },
};
