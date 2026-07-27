/**
 * instagram.mjs — Instagram 平台适配器（CLI 桥接 opencli）
 */

import { execCLI } from "../bridge.mjs";

const _actions = {
  search: (q) => execCLI("opencli", ["instagram", "search", q, "-f", "yaml"], { parseAs: "text" }),
  profile: (id) => execCLI("opencli", ["instagram", "profile", id, "-f", "yaml"], { parseAs: "text" }),
  user: (id, opts) => execCLI("opencli", ["instagram", "user", id, "--limit", String(opts?.limit ?? 12), "-f", "yaml"], { parseAs: "text" }),
  explore: (_, opts) => execCLI("opencli", ["instagram", "explore", "--limit", String(opts?.limit ?? 20), "-f", "yaml"], { parseAs: "text" }),
};

export default {
  name: "instagram",
  async execute(action, query, opts) {
    const fn = _actions[action];
    if (!fn) throw new Error(`instagram: unknown action "${action}". Available: search, profile, user, explore`);
    const r = await fn(query, opts);
    if (!r.ok) throw new Error(`instagram/opencli: ${r.stderr || "command failed"}`);
    return r.data;
  },
};
