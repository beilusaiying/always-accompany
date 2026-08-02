/**
 * git-tools.mjs — 结构化 git 工具（从 YonBan git-tools.ts 1:1 移植）
 * 纯 child_process.execFile，无 shell 注入风险。
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import { getWorkspaceRoot, resolveWorkspacePath } from "../infra.mjs";

function _cwdOf(params) {
  const c = params && typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : "";
  return c ? resolveWorkspacePath(c) : undefined;
}

// ── git 可执行文件解析（A2 容错，_问题记录_20260516 实锤）──
// why: 原 execFile("git") 直连子进程 PATH,若 git 不在该 PATH → 9 个 git 工具全报 ENOENT,
//   而 run_command 走 cmd.exe 能从 shell PATH 解析到 git（PATH 解析路径不同）。
//   根因修=探测 git 绝对路径供 execFile 用,不破坏"纯 execFile 无 shell 注入"契约(头注释)。
// 探测范式照抄 code-tools.mjs _resolveAstGrepBin(候选名→spawnSync --version 探测→缓存)。
// 影响面: _runGit 是 9 个 git 工具(status/diff/log/add/commit/branch/checkout/stash/merge)单一入口,改此一处全覆盖。
let _gitBin;
function _resolveGitBin() {
  if (typeof _gitBin === "string") return _gitBin;
  const isWin = process.platform === "win32";
  // 候选:先试 PATH 名(命中即用),再试 Windows 常见安装绝对路径(PATH 缺失时的兜底)
  const candidates = isWin
    ? ["git", "git.exe",
       "C:\\Program Files\\Git\\bin\\git.exe",
       "C:\\Program Files\\Git\\cmd\\git.exe",
       "C:\\Program Files (x86)\\Git\\bin\\git.exe",
       process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\git.exe` : null]
    : ["git", "/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  for (const bin of candidates) {
    if (!bin) continue;
    // 绝对路径先查存在性(避免对不存在路径 spawn 的开销);PATH 名直接探测
    if ((bin.includes("/") || bin.includes("\\")) && !fs.existsSync(bin)) continue;
    try {
      const probe = cp.spawnSync(bin, ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
      if (!probe.error && probe.status === 0) { _gitBin = bin; return bin; }
    } catch { /* next */ }
  }
  return null;
}

function _runGit(args, cwd) {
  const root = cwd || getWorkspaceRoot();
  return new Promise((resolve) => {
    // A2 容错:用探测到的 git 绝对路径(PATH 缺失时兜底);探测不到则回退字面 "git"(保持原 ENOENT 响亮提示)
    const gitBin = _resolveGitBin() || "git";
    cp.execFile(gitBin, args, { cwd: root, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : (err ? 1 : 0);
      let errText = String(stderr || "");
      if (err && !errText.trim()) {
        const m = err.message || String(err);
        errText = err.code === "ENOENT"
          ? `git 不可执行（ENOENT：探测候选路径均无 git，git 未安装或不在标准位置）。请安装 git 或将 git.exe 加入 PATH。原始错误: ${m}`
          : m;
      }
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: errText, code });
    });
  });
}

export async function gitStatus(params = {}) {
  const r = await _runGit(["status", "--porcelain=v1", "-b"], _cwdOf(params));
  if (!r.ok && !r.stdout) return { success: false, error: (r.stderr.trim() || "git status 失败") + "（仓库若在工作区子目录，传 cwd 指定）" };
  let branch = "", ahead = 0, behind = 0;
  const staged = [], unstaged = [], untracked = [];
  for (const ln of r.stdout.split("\n")) {
    if (!ln) continue;
    if (ln.startsWith("##")) {
      const m = ln.slice(2).trim();
      branch = m.split("...")[0].split(" ")[0];
      const am = m.match(/ahead (\d+)/); if (am) ahead = Number(am[1]);
      const bm = m.match(/behind (\d+)/); if (bm) behind = Number(bm[1]);
      continue;
    }
    const x = ln[0], y = ln[1], file = ln.slice(3);
    if (x === "?" && y === "?") { untracked.push(file); continue; }
    if (x !== " " && x !== "?") staged.push(file);
    if (y !== " " && y !== "?") unstaged.push(file);
  }
  return { success: true, branch, ahead, behind, staged, unstaged, untracked, clean: !staged.length && !unstaged.length && !untracked.length };
}

export async function gitDiff(params) {
  const args = ["diff", "--no-color"];
  if (params.staged === true || params.cached === true) args.push("--cached");
  if (typeof params.path === "string" && params.path) args.push("--", params.path);
  const r = await _runGit(args, _cwdOf(params));
  if (!r.ok && !r.stdout) return { success: false, error: r.stderr.trim() || "git diff 失败" };
  return { success: true, diff: r.stdout, empty: !r.stdout.trim() };
}

export async function gitLog(params) {
  const n = Math.min(Math.max(Number(params.maxCount) || 20, 1), 200);
  const SEP = "\x1f", REC = "\x1e";
  const r = await _runGit(["log", `-n${n}`, `--format=%H${SEP}%an${SEP}%ad${SEP}%s${REC}`, "--date=iso"], _cwdOf(params));
  if (!r.ok && !r.stdout) return { success: false, error: r.stderr.trim() || "git log 失败" };
  const commits = r.stdout.split(REC).map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [hash, author, date, subject] = rec.split(SEP);
    return { hash, author, date, subject };
  });
  return { success: true, commits };
}

export async function gitAdd(params) {
  const paths = Array.isArray(params.paths) ? params.paths
    : (typeof params.path === "string" && params.path ? [params.path] : ["-A"]);
  const r = await _runGit(["add", ...paths], _cwdOf(params));
  if (!r.ok) return { success: false, error: r.stderr.trim() || "git add 失败" };
  return { success: true, added: paths };
}

export async function gitCommit(params) {
  const msg = typeof params.message === "string" ? params.message.trim() : "";
  if (!msg) return { success: false, error: "缺少 message 参数" };
  const args = ["commit", "-m", msg];
  if (params.all === true) args.splice(1, 0, "-a");
  const cwd = _cwdOf(params);
  const r = await _runGit(args, cwd);
  if (!r.ok) return { success: false, error: (r.stderr || r.stdout).trim() || "git commit 失败（无暂存改动？）" };
  const h = await _runGit(["rev-parse", "HEAD"], cwd);
  return { success: true, hash: h.stdout.trim().slice(0, 40), output: r.stdout.trim() };
}

export async function gitBranch(params) {
  if (typeof params.create === "string" && params.create) {
    const r = await _runGit(["checkout", "-b", params.create], _cwdOf(params));
    if (!r.ok) return { success: false, error: r.stderr.trim() || "git 新建分支失败" };
    return { success: true, created: params.create, current: params.create };
  }
  const r = await _runGit(["branch", "--no-color"], _cwdOf(params));
  if (!r.ok) return { success: false, error: r.stderr.trim() || "git branch 失败" };
  let current = "";
  const branches = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).map((b) => {
    if (b.startsWith("* ")) { current = b.slice(2); return current; }
    return b;
  });
  return { success: true, branches, current };
}

export async function gitCheckout(params) {
  const branch = typeof params.branch === "string" ? params.branch.trim() : "";
  if (!branch) return { success: false, error: "缺少 branch 参数" };
  const r = await _runGit(["checkout", branch], _cwdOf(params));
  if (!r.ok) return { success: false, error: r.stderr.trim() || "git checkout 失败" };
  return { success: true, current: branch, output: r.stdout.trim() };
}

export async function gitStash(params) {
  const action = (typeof params.action === "string" ? params.action : "list").trim();
  const cwd = _cwdOf(params);
  switch (action) {
    case "list": {
      const r = await _runGit(["stash", "list"], cwd);
      if (!r.ok && !r.stdout) return { success: false, error: r.stderr.trim() || "git stash list 失败" };
      const entries = r.stdout.split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^(stash@\{\d+\}):\s*(.*)$/);
        return m ? { ref: m[1], message: m[2] } : { ref: "", message: line };
      });
      return { success: true, entries };
    }
    case "push": {
      const msg = typeof params.message === "string" ? params.message.trim() : "";
      const args = ["stash", "push"];
      if (msg) args.push("-m", msg);
      if (params.includeUntracked === true) args.push("--include-untracked");
      const r = await _runGit(args, cwd);
      if (!r.ok) return { success: false, error: r.stderr.trim() || "git stash push 失败" };
      return { success: true, output: r.stdout.trim() };
    }
    case "pop": {
      const ref = typeof params.ref === "string" ? params.ref : "";
      const args = ["stash", "pop"];
      if (ref) args.push(ref);
      const r = await _runGit(args, cwd);
      if (!r.ok) return { success: false, error: (r.stderr || r.stdout).trim() || "git stash pop 失败" };
      return { success: true, output: r.stdout.trim() };
    }
    case "apply": {
      const ref = typeof params.ref === "string" ? params.ref : "";
      const args = ["stash", "apply"];
      if (ref) args.push(ref);
      const r = await _runGit(args, cwd);
      if (!r.ok) return { success: false, error: (r.stderr || r.stdout).trim() || "git stash apply 失败" };
      return { success: true, output: r.stdout.trim() };
    }
    case "drop": {
      const ref = typeof params.ref === "string" ? params.ref : "";
      const args = ["stash", "drop"];
      if (ref) args.push(ref);
      const r = await _runGit(args, cwd);
      if (!r.ok) return { success: false, error: r.stderr.trim() || "git stash drop 失败" };
      return { success: true, output: r.stdout.trim() };
    }
    default:
      return { success: false, error: `未知 stash action: ${action}（支持 list/push/pop/apply/drop）` };
  }
}

export async function gitMerge(params) {
  const branch = typeof params.branch === "string" ? params.branch.trim() : "";
  if (!branch) return { success: false, error: "缺少 branch 参数" };
  const args = ["merge", branch];
  if (params.noFf === true) args.push("--no-ff");
  if (typeof params.message === "string" && params.message) args.push("-m", params.message);
  const r = await _runGit(args, _cwdOf(params));
  if (!r.ok) {
    const hasConflict = r.stdout.includes("CONFLICT") || r.stderr.includes("CONFLICT");
    return { success: false, error: (r.stderr || r.stdout).trim(), conflict: hasConflict };
  }
  return { success: true, output: r.stdout.trim() };
}
