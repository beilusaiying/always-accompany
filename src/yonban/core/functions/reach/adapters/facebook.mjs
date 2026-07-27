/**
 * facebook.mjs — Facebook 平台适配器（CLI 桥接 opencli）
 */

import { execCLI } from "../bridge.mjs";

const _actions = {
  search: (q) => execCLI("opencli", ["facebook", "search", q, "-f", "yaml"], { parseAs: "text" }),
  profile: (id) => execCLI("opencli", ["facebook", "profile", id, "-f", "yaml"], { parseAs: "text" }),
  feed: (_, opts) => execCLI("opencli", ["facebook", "feed", "--limit", String(opts?.limit ?? 10), "-f", "yaml"], { parseAs: "text" }),
};

export default {
  name: "facebook",
  async execute(action, query, opts) {
    const fn = _actions[action];
    if (!fn) throw new Error(`facebook: unknown action "${action}". Available: search, profile, feed`);
    const r = await fn(query, opts);
    if (!r.ok) throw new Error(`facebook/opencli: ${r.stderr || "command failed"}`);
    return r.data;
  },
};
