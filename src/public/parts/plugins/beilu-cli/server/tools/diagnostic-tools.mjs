/**
 * diagnostic-tools.mjs — 诊断工具 CLI 替代实现
 * 原版用 vscode.languages.getDiagnostics，CLI 版用 tsc/eslint CLI
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getWorkspaceRoot, resolveWorkspacePath } from "../infra.mjs";
import { DIAGNOSTICS_MAX } from "../constants.mjs";

export async function getDiagnostics(params) {
  const wsRoot = getWorkspaceRoot();
  const filePath = typeof params?.path === "string" ? params.path : "";
  const severityFilter = typeof params?.severity === "string" ? params.severity : "";
  const diagnostics = [];

  // TypeScript diagnostics via tsc
  try {
    const tscArgs = ["tsc", "--noEmit", "--pretty", "false"];
    const tscResult = cp.spawnSync("npx", tscArgs, {
      timeout: 30000, windowsHide: true, encoding: "utf-8", cwd: wsRoot, shell: true,
    });
    const output = tscResult.stdout || "";
    for (const line of output.split("\n")) {
      const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+\w+:\s*(.+)/);
      if (!m) continue;
      const file = path.relative(wsRoot, m[1]).replace(/\\/g, "/");
      const severity = m[4];
      if (filePath && !file.includes(filePath)) continue;
      if (severityFilter && severity !== severityFilter) continue;
      diagnostics.push({ file, line: parseInt(m[2]), column: parseInt(m[3]), severity, message: m[5].trim(), source: "tsc" });
      if (diagnostics.length >= DIAGNOSTICS_MAX) break;
    }
  } catch { /* tsc unavailable */ }

  // ESLint diagnostics
  if (diagnostics.length < DIAGNOSTICS_MAX) {
    try {
      const eslintTarget = filePath ? resolveWorkspacePath(filePath) : ".";
      const eslintResult = cp.spawnSync("npx", ["eslint", "--format", "json", eslintTarget], {
        timeout: 30000, windowsHide: true, encoding: "utf-8", cwd: wsRoot, shell: true,
      });
      const stdout = eslintResult.stdout || "";
      try {
        const results = JSON.parse(stdout);
        if (Array.isArray(results)) {
          for (const r of results) {
            const file = path.relative(wsRoot, r.filePath || "").replace(/\\/g, "/");
            for (const msg of (r.messages || [])) {
              const severity = msg.severity === 2 ? "error" : "warning";
              if (severityFilter && severity !== severityFilter) continue;
              diagnostics.push({ file, line: msg.line || 1, column: msg.column || 1, severity, message: msg.message, source: `eslint:${msg.ruleId || ""}` });
              if (diagnostics.length >= DIAGNOSTICS_MAX) break;
            }
            if (diagnostics.length >= DIAGNOSTICS_MAX) break;
          }
        }
      } catch { /* not json */ }
    } catch { /* eslint unavailable */ }
  }

  return { total: diagnostics.length, shown: diagnostics.length, diagnostics };
}

export async function getStatus() {
  const wsRoot = getWorkspaceRoot();
  const result = {
    workspace: wsRoot,
    workspaceFolders: [wsRoot],
    platform: { os: process.platform, arch: process.arch, node: process.version },
    diagnostics: { errors: 0, warnings: 0 },
  };

  // git status
  try {
    const gitResult = cp.spawnSync("git", ["status", "--porcelain=v1", "-b"], {
      timeout: 5000, windowsHide: true, encoding: "utf-8", cwd: wsRoot,
    });
    if (!gitResult.error && gitResult.stdout) {
      const lines = gitResult.stdout.split("\n").filter(Boolean);
      const branchLine = lines.find(l => l.startsWith("##"));
      result.git = {
        branch: branchLine ? branchLine.slice(3).split("...")[0].split(" ")[0] : "unknown",
        changes: lines.filter(l => !l.startsWith("##")).length,
      };
    }
  } catch { /* git unavailable */ }

  // project info
  const pkgPath = path.join(wsRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      result.project = { name: pkg.name, version: pkg.version, type: "Node.js" };
    } catch { /* ignore */ }
  }

  return result;
}
