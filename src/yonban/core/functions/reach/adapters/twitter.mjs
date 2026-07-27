/**
 * twitter.mjs — Twitter/X 平台适配器（CLI 桥接）
 *
 * 后端优先级：twitter-cli > opencli
 * 需要：TWITTER_AUTH_TOKEN + TWITTER_CT0 环境变量或已 login。
 */

import { execCLI, probeCommand } from "../bridge.mjs";

async function _detectBackend() {
  if ((await probeCommand("twitter")).status === "ok") return "twitter-cli";
  if ((await probeCommand("opencli", ["--version"])).status === "ok") return "opencli";
  return null;
}

function _twitterEnv(opts) {
  const env = {};
  if (opts?.config?.twitterAuthToken) env.TWITTER_AUTH_TOKEN = opts.config.twitterAuthToken;
  if (opts?.config?.twitterCt0) env.TWITTER_CT0 = opts.config.twitterCt0;
  return Object.keys(env).length ? { env } : {};
}

const _twitterCli = {
  async search(query, opts) {
    return execCLI("twitter", ["search", query, "-n", String(opts?.limit ?? 10), "--json"], { parseAs: "json", timeout: 15000, ..._twitterEnv(opts) });
  },
  async read(id, opts) {
    return execCLI("twitter", ["tweet", id, "--json"], { parseAs: "json", ..._twitterEnv(opts) });
  },
  async user(username, opts) {
    return execCLI("twitter", ["user", username.replace(/^@/, ""), "--json"], { parseAs: "json", ..._twitterEnv(opts) });
  },
  async feed(_, opts) {
    return execCLI("twitter", ["feed", "-n", String(opts?.limit ?? 20), "--json"], { parseAs: "json", ..._twitterEnv(opts) });
  },
};

const _opencli = {
  async search(query) {
    return execCLI("opencli", ["twitter", "search", query, "-f", "yaml"], { parseAs: "text" });
  },
  async read(id) {
    return execCLI("opencli", ["twitter", "article", id, "-f", "yaml"], { parseAs: "text" });
  },
  async user(username) {
    return execCLI("opencli", ["twitter", "user-posts", username.replace(/^@/, ""), "-f", "yaml"], { parseAs: "text" });
  },
  async feed() {
    return execCLI("opencli", ["twitter", "search", "trending", "-f", "yaml"], { parseAs: "text" });
  },
};

export default {
  name: "twitter",

  async execute(action, query, opts) {
    const backend = await _detectBackend();
    if (!backend) throw new Error("twitter: no backend available (install twitter-cli or opencli)");

    const impl = backend === "twitter-cli" ? _twitterCli : _opencli;
    const fn = impl[action];
    if (!fn) throw new Error(`twitter: unknown action "${action}". Available: search, read, user, feed`);

    const result = await fn(query, opts);
    if (!result.ok) throw new Error(`twitter/${backend}: ${result.stderr || "command failed"}`);
    return result.data;
  },
};
