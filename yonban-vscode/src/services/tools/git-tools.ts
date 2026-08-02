/**
 * git-tools.ts -- 结构化 git 工具（G-2 系列，10 个 git_* 操作）
 *
 * ═══════════════════════════════════════════════════════════════
 *  使用链路（每个 tool_call 的完整传导路径）
 * ═══════════════════════════════════════════════════════════════
 *
 * 通用路径：
 *   AI 需要版本控制操作（暂存/提交/分支/回退等）
 *     → tool_call git_status / git_diff / git_log / git_add / git_commit /
 *       git_branch / git_checkout / git_stash / git_merge
 *     → _runGit(cp.execFile) 以数组参数调用 git，不过 shell，无注入风险
 *     → 统一返回 { ok, stdout, stderr, code }
 *     → 各工具解析 stdout 为结构化 JSON 返回给 AI
 *
 * 安全说明：
 *   _runGit 使用 cp.execFile（不过 shell），参数以数组传入，
 *   不存在命令注入风险。git push 等危险操作由 COMMAND_BLACKLIST 在上游拦截。
 *
 * 相交：
 *   ← ToolExecutor.ts execute（_handlers 注册表路由到此）
 *   → tool-infra.ts getWorkspaceRoot（获取工作区根目录作为 cwd）
 */
import * as cp from "child_process";
import { getWorkspaceRoot, resolveWorkspacePath } from "../tool-infra";

/** cwd 参数 → 工作区内绝对路径（越界抛异常 fail-closed，与文件工具同一道门）。
 *  0715 根因：git 家族恒以 workspaceFolders[0] 为 cwd，而仓库可以在工作区子目录
 *  （实证：工作区根 beilu-与你之诗 无 .git，仓库在 测试1/.git → git_status 全线
 *  "not a git repository"，但 search/read 系工具因有 path 参数畅通 → 能力不对称）。
 *  统一用 cwd 命名（path 在 git_diff/git_add 已是"文件限定"语义，复用会撞车；run_script 先例=cwd）。 */
function _cwdOf(params?: Record<string, unknown>): string | undefined {
  const c = params && typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : "";
  return c ? resolveWorkspacePath(c) : undefined;
}

/** 在工作区根（或 cwd 指定的子目录）跑 git（execFile 不过 shell，无注入；不抛，统一返回 {ok,stdout,stderr,code}）。 */
function _runGit(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const root = cwd || getWorkspaceRoot();
  return new Promise((resolve) => {
    cp.execFile("git", args, { cwd: root, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : (err ? 1 : 0);
      let errText = String(stderr || "");
      // 0714 吞错修：spawn 层失败（ENOENT=git 不在 PATH/刚装完未重启 VSCode、EPERM 等）stderr 为空，
      // 各 git_* 工具兜底文案「当前目录是 git 仓库吗？」把真因误导成仓库问题（用户装了 git 仍全线
      // success:false 且无从排查）。stderr 空时透传 err.message，让 AI/用户看到 ENOENT/权限等根因。
      if (err && !errText.trim()) {
        const m = (err as Error).message || String(err);
        errText = ((err as { code?: unknown }).code === "ENOENT")
          ? `git 不可执行（ENOENT：git 不在 PATH，或安装后未重启 VSCode）。原始错误: ${m}`
          : m;
      }
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: errText, code });
    });
  });
}

/** git_status：分支 + ahead/behind + 暂存/未暂存/未跟踪（porcelain 解析为结构化）。 */
export async function gitStatus(params: Record<string, unknown> = {}): Promise<unknown> {
  const r = await _runGit(["status", "--porcelain=v1", "-b"], _cwdOf(params));
  if (!r.ok && !r.stdout) return { success: false, error: (r.stderr.trim() || "git status 失败（当前目录是 git 仓库吗？）") + "（仓库若在工作区子目录，传 cwd 指定）" };
  let branch = "", ahead = 0, behind = 0;
  const staged: string[] = [], unstaged: string[] = [], untracked: string[] = [];
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

/** git_diff：staged?=工作区/暂存区，path? 限定文件。返回 diff 文本。 */
export async function gitDiff(params: Record<string, unknown>): Promise<unknown> {
  const args = ["diff", "--no-color"];
  if (params.staged === true || params.cached === true) args.push("--cached");
  if (typeof params.path === "string" && params.path) args.push("--", params.path);
  const r = await _runGit(args, _cwdOf(params));
  if (!r.ok && !r.stdout) return { success: false, error: r.stderr.trim() || "git diff 失败" };
  return { success: true, diff: r.stdout, empty: !r.stdout.trim() };
}

/** git_log：最近 N 条（默认 20，上限 200），结构化 {hash,author,date,subject}。 */
export async function gitLog(params: Record<string, unknown>): Promise<unknown> {
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

/** git_add：暂存 paths（数组或单 path），不传则暂存全部(-A)。 */
export async function gitAdd(params: Record<string, unknown>): Promise<unknown> {
  const paths = Array.isArray(params.paths) ? (params.paths as string[])
    : (typeof params.path === "string" && params.path ? [params.path] : ["-A"]);
  const r = await _runGit(["add", ...paths], _cwdOf(params));
  if (!r.ok) return { success: false, error: r.stderr.trim() || "git add 失败" };
  return { success: true, added: paths };
}

/** git_commit：message 必填；all?=true 等价 commit -a。返回新 commit hash。 */
export async function gitCommit(params: Record<string, unknown>): Promise<unknown> {
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

/** git_branch：无参=列分支(标当前)；create=名字 → 新建并切换(checkout -b)。 */
export async function gitBranch(params: Record<string, unknown>): Promise<unknown> {
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

/** git_checkout：切换到已有分支。 */
export async function gitCheckout(params: Record<string, unknown>): Promise<unknown> {
  const branch = typeof params.branch === "string" ? params.branch.trim() : "";
  if (!branch) return { success: false, error: "缺少 branch 参数" };
  const r = await _runGit(["checkout", branch], _cwdOf(params));
  if (!r.ok) return { success: false, error: r.stderr.trim() || "git checkout 失败" };
  return { success: true, current: branch, output: r.stdout.trim() };
}

/** git_stash：list/push/pop/apply/drop。 */
export async function gitStash(params: Record<string, unknown>): Promise<unknown> {
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
      const ref2 = typeof params.ref === "string" ? params.ref : "";
      const args = ["stash", "apply"];
      if (ref2) args.push(ref2);
      const r = await _runGit(args, cwd);
      if (!r.ok) return { success: false, error: (r.stderr || r.stdout).trim() || "git stash apply 失败" };
      return { success: true, output: r.stdout.trim() };
    }
    case "drop": {
      const ref3 = typeof params.ref === "string" ? params.ref : "";
      const args = ["stash", "drop"];
      if (ref3) args.push(ref3);
      const r = await _runGit(args, cwd);
      if (!r.ok) return { success: false, error: r.stderr.trim() || "git stash drop 失败" };
      return { success: true, output: r.stdout.trim() };
    }
    default:
      return { success: false, error: `未知 stash action: ${action}（支持 list/push/pop/apply/drop）` };
  }
}

/** git_merge：合并分支。 */
export async function gitMerge(params: Record<string, unknown>): Promise<unknown> {
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
