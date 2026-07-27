import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs"; // 0716 收口：原子写单源（原内联 tmp+rename；旧 tmp 名无 Date.now=并发互覆面，单源已含）
import { getUserDictionary } from "../../../../../yonban/core/functions/security/auth.mjs";
import { encryptSecret, decryptSecret } from "../../../../../yonban/core/functions/security/secret_box.mjs";
import { GITHUB_FETCH_TIMEOUT_MS } from "../../../../../yonban/core/functions/rollback/deleteConfig.mjs"; // T8·回切：改指 yonban 新位实现体

function _configPath(username) {
  return path.join(getUserDictionary(username), "github_config.json");
}

function _loadConfig(username) {
  const p = _configPath(username);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (raw.token) raw.token = decryptSecret(raw.token);
    return raw;
  } catch { return null; }
}

function _saveConfig(username, cfg) {
  const p = _configPath(username);
  const toSave = { ...cfg };
  if (toSave.token) toSave.token = encryptSecret(toSave.token);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  nicerWriteFileSync(p, JSON.stringify(toSave, null, "\t")); // 0716 收口：原子写单源
}

function _exec(cmd, args, cwd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function _git(args, cwd, timeout) {
  return _exec("git", args, cwd, timeout);
}

/**
 * 验证 GitHub PAT 并返回用户信息。
 */
export async function verifyToken(token) {
  try {
    const resp = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "beilu-app" },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return { success: false, error: `GitHub API ${resp.status}: ${resp.statusText}` };
    const user = await resp.json();
    return { success: true, login: user.login, name: user.name, avatar: user.avatar_url, id: user.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 列出用户可访问的仓库。
 */
export async function listRepos(token, page = 1, perPage = 30) {
  try {
    const resp = await fetch(`https://api.github.com/user/repos?sort=pushed&per_page=${perPage}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "beilu-app" },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return { success: false, error: `GitHub API ${resp.status}` };
    const repos = await resp.json();
    return {
      success: true,
      repos: repos.map(r => ({ full_name: r.full_name, private: r.private, default_branch: r.default_branch, description: r.description })),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 关联 GitHub 账号/仓库。
 */
export async function linkGitHub(username, { token, repo, branch = "main" }) {
  const verify = await verifyToken(token);
  if (!verify.success) return { success: false, error: "Token 验证失败: " + verify.error };

  _saveConfig(username, {
    login: verify.login,
    name: verify.name,
    avatar: verify.avatar,
    repo,
    branch,
    token,
    linkedAt: new Date().toISOString(),
    lastPush: null,
  });

  return { success: true, login: verify.login, repo, branch };
}

/**
 * 取消关联。
 */
export async function unlinkGitHub(username, workDir) {
  const p = _configPath(username);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
  if (workDir) {
    try { await _git(["remote", "remove", "origin"], workDir); } catch {}
  }
  return { success: true };
}

/**
 * 获取 GitHub 关联状态。
 */
export function getGitHubStatus(username) {
  const cfg = _loadConfig(username);
  if (!cfg) return { linked: false };
  return {
    linked: true,
    login: cfg.login,
    name: cfg.name,
    avatar: cfg.avatar,
    repo: cfg.repo,
    branch: cfg.branch,
    lastPush: cfg.lastPush,
    linkedAt: cfg.linkedAt,
  };
}

/**
 * 测试连接（验证 token 仍有效）。
 */
export async function testConnection(username) {
  const cfg = _loadConfig(username);
  if (!cfg?.token) return { success: false, error: "未关联 GitHub" };
  return verifyToken(cfg.token);
}

/**
 * 在工作目录初始化 git 仓库（如果还没有）。
 */
export async function ensureGitRepo(workDir) {
  try {
    await _git(["rev-parse", "--git-dir"], workDir);
    return { success: true, alreadyInit: true };
  } catch {
    try {
      await _git(["init"], workDir);
      return { success: true, alreadyInit: false };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

/**
 * 确保 remote origin 指向正确仓库。
 */
export async function ensureRemote(username, workDir) {
  const cfg = _loadConfig(username);
  if (!cfg?.token || !cfg?.repo) return { success: false, error: "未关联 GitHub" };

  const remoteUrl = `https://${cfg.token}@github.com/${cfg.repo}.git`;
  try {
    const { stdout } = await _git(["remote", "get-url", "origin"], workDir);
    if (!stdout.includes(cfg.repo)) {
      await _git(["remote", "set-url", "origin", remoteUrl], workDir);
    }
  } catch {
    await _git(["remote", "add", "origin", remoteUrl], workDir);
  }
  return { success: true };
}

/**
 * 自动 commit + push。
 */
export async function autoCommitAndPush(username, workDir, { files = [], message = "" } = {}) {
  const cfg = _loadConfig(username);
  if (!cfg?.token || !cfg?.repo) return { success: false, error: "未关联 GitHub" };

  try {
    await ensureGitRepo(workDir);
    await ensureRemote(username, workDir);

    if (files.length > 0) {
      await _git(["add", ...files], workDir);
    } else {
      await _git(["add", "-A"], workDir);
    }

    const { stdout: statusOut } = await _git(["status", "--porcelain"], workDir);
    if (!statusOut.trim()) return { success: true, skipped: true, reason: "nothing to commit" };

    const commitMsg = message || `[beilu-auto] ${new Date().toISOString()}`;
    await _git(["commit", "-m", commitMsg], workDir);

    await _git(["push", "origin", cfg.branch || "main"], workDir, 60000);

    cfg.lastPush = new Date().toISOString();
    _saveConfig(username, cfg);

    return { success: true, pushed: true };
  } catch (e) {
    const _sanitize = (s) => cfg.token ? String(s || "").replaceAll(cfg.token, "***") : String(s || "");
    return { success: false, error: _sanitize(e.message), stderr: _sanitize(e.stderr) };
  }
}

/**
 * 手动同步（commit all + push）。
 */
export async function syncToGitHub(username, workDir, message = "", folders) {
  return autoCommitAndPush(username, workDir, {
    files: folders && folders.length > 0 ? folders : [],
    message: message || `[beilu-sync] 手动同步 ${new Date().toISOString()}`,
  });
}
