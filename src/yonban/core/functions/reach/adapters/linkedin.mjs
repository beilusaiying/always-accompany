/**
 * linkedin.mjs — LinkedIn 平台适配器（CLI 桥接 mcporter + Jina fallback）
 */

import { execCLI, probeCommand } from "../bridge.mjs";

async function _detectBackend() {
  if ((await probeCommand("mcporter", ["--version"])).status === "ok") return "mcporter";
  return "jina";
}

const _mcporter = {
  profile: (url) => execCLI("mcporter", ["call", `linkedin-scraper.get_person_profile(linkedin_url: "${url}")`], { parseAs: "text", timeout: 30000 }),
  "search-people": (q, opts) => execCLI("mcporter", ["call", `linkedin-scraper.search_people(keyword: "${q}", limit: ${opts?.limit ?? 10})`], { parseAs: "text", timeout: 30000 }),
  "search-jobs": (q, opts) => execCLI("mcporter", ["call", `linkedin-scraper.search_jobs(keyword: "${q}", limit: ${opts?.limit ?? 10})`], { parseAs: "text", timeout: 30000 }),
  company: (url) => execCLI("mcporter", ["call", `linkedin-scraper.get_company_profile(linkedin_url: "${url}")`], { parseAs: "text", timeout: 30000 }),
};

export default {
  name: "linkedin",
  async execute(action, query, opts) {
    const backend = await _detectBackend();
    if (backend === "jina") {
      const url = query.startsWith("http") ? query : `https://linkedin.com/in/${query}`;
      const resp = await fetch(`https://r.jina.ai/${url}`, {
        headers: { "User-Agent": "beilu-reach/1.0", Accept: "text/plain" },
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`Jina/LinkedIn ${resp.status}`);
      return await resp.text();
    }
    const fn = _mcporter[action];
    if (!fn) throw new Error(`linkedin: unknown action "${action}". Available: profile, search-people, search-jobs, company`);
    const r = await fn(query, opts);
    if (!r.ok) throw new Error(`linkedin/mcporter: ${r.stderr || "command failed"}`);
    return r.data;
  },
};
