/**
 * github.mjs — GitHub 平台适配器（CLI 桥接 gh CLI）
 *
 * 零配置可用（匿名 60 次/h），配置 Token 提升到 5000 次/h。
 */

import { execCLI } from "../bridge.mjs";

function _ghEnv(opts) {
  const env = {};
  if (opts?.config?.githubToken) env.GH_TOKEN = opts.config.githubToken;
  return Object.keys(env).length ? { env } : {};
}

export default {
  name: "github",

  async execute(action, query, opts) {
    switch (action) {
      case "search-repos":
        return _searchRepos(query, opts);
      case "search-code":
        return _searchCode(query, opts);
      case "repo":
        return _repo(query, opts);
      case "issues":
        return _issues(query, opts);
      case "prs":
        return _prs(query, opts);
      default:
        throw new Error(`github: unknown action "${action}". Available: search-repos, search-code, repo, issues, prs`);
    }
  },
};

async function _searchRepos(query, opts) {
  const limit = opts?.limit ?? 10;
  const r = await execCLI("gh", [
    "search", "repos", query, "--sort", "stars", "--limit", String(limit),
    "--json", "fullName,description,stargazersCount,language,updatedAt",
  ], { parseAs: "json", timeout: 15000, ..._ghEnv(opts) });
  if (!r.ok) throw new Error(`gh search repos: ${r.stderr}`);
  return r.data;
}

async function _searchCode(query, opts) {
  const limit = opts?.limit ?? 10;
  const args = ["search", "code", query, "--limit", String(limit), "--json", "repository,path,textMatches"];
  if (opts?.language) args.push("--language", opts.language);
  const r = await execCLI("gh", args, { parseAs: "json", timeout: 15000, ..._ghEnv(opts) });
  if (!r.ok) throw new Error(`gh search code: ${r.stderr}`);
  return r.data;
}

async function _repo(name, opts) {
  const r = await execCLI("gh", ["repo", "view", name, "--json", "name,description,stargazersCount,forkCount,url,defaultBranchRef,languages,licenseInfo"], { parseAs: "json", ..._ghEnv(opts) });
  if (!r.ok) throw new Error(`gh repo view: ${r.stderr}`);
  return r.data;
}

async function _issues(repo, opts) {
  const limit = opts?.limit ?? 10;
  const state = opts?.state || "open";
  const r = await execCLI("gh", [
    "issue", "list", "-R", repo, "--state", state, "--limit", String(limit),
    "--json", "number,title,state,author,createdAt,labels",
  ], { parseAs: "json", ..._ghEnv(opts) });
  if (!r.ok) throw new Error(`gh issue list: ${r.stderr}`);
  return r.data;
}

async function _prs(repo, opts) {
  const limit = opts?.limit ?? 10;
  const state = opts?.state || "open";
  const r = await execCLI("gh", [
    "pr", "list", "-R", repo, "--state", state, "--limit", String(limit),
    "--json", "number,title,state,author,createdAt,labels",
  ], { parseAs: "json", ..._ghEnv(opts) });
  if (!r.ok) throw new Error(`gh pr list: ${r.stderr}`);
  return r.data;
}
