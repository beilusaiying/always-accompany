/**
 * diagnostic-tools.ts -- IDE 诊断与状态快照工具（get_diagnostics + get_status）
 *
 * ═══════════════════════════════════════════════════════════════
 *  使用链路（每个 tool_call 的完整传导路径）
 * ═══════════════════════════════════════════════════════════════
 *
 * getDiagnostics:
 *   AI 需要检查代码编译/lint 错误
 *     → tool_call get_diagnostics { path?, severity? }
 *     → vscode.languages.getDiagnostics() 获取 LSP 诊断
 *     → 按 severity 过滤，按 path 限定文件
 *     → 返回 { total, shown, diagnostics: [{ file, line, column, severity, message, source }] }
 *     → AI 据此定位并修复错误
 *
 * getStatus:
 *   AI 需要了解 IDE 当前状态（工作区/编辑器/诊断统计）
 *     → tool_call get_status
 *     → 读取 vscode.workspace / vscode.window / vscode.languages 状态
 *     → 返回 { workspace, activeEditor, diagnostics: {errors, warnings}, extensions }
 *     → AI 据此了解环境并做出决策
 *
 * 相交：
 *   ← ToolExecutor.ts execute（_handlers 注册表路由到此）
 *   → tool-infra.ts getWorkspaceRoot（获取工作区根目录用于相对路径计算）
 *   → tool-infra.ts resolveWorkspacePath（path 参数安全解析）
 *   → vscode.languages.getDiagnostics（VSCode LSP 诊断 API）
 */
import * as path from "path";
import * as vscode from "vscode";
import { getWorkspaceRoot, resolveWorkspacePath } from "../tool-infra";

/** 获取当前诊断信息 */
export async function getDiagnostics(
  params: Record<string, unknown>,
): Promise<unknown> {
  const severity = params.severity as string;
  const filePath = params.path as string;

  let diagnostics = vscode.languages.getDiagnostics();

  if (filePath) {
    const absPath = resolveWorkspacePath(filePath);
    const targetUri = vscode.Uri.file(absPath);
    diagnostics = diagnostics.filter(
      ([uri]) => uri.fsPath === targetUri.fsPath,
    );
  }

  const items: Array<{
    file: string;
    line: number;
    column: number;
    severity: string;
    message: string;
    source?: string;
  }> = [];

  const severityMap: Record<number, string> = {
    [vscode.DiagnosticSeverity.Error]: "error",
    [vscode.DiagnosticSeverity.Warning]: "warning",
    [vscode.DiagnosticSeverity.Information]: "info",
    [vscode.DiagnosticSeverity.Hint]: "hint",
  };

  for (const [uri, diags] of diagnostics) {
    const wsRoot = getWorkspaceRoot();
    const relPath = wsRoot ? path.relative(wsRoot, uri.fsPath) : uri.fsPath;

    for (const d of diags) {
      const sev = severityMap[d.severity] || "unknown";
      if (severity === "error" && sev !== "error") continue;
      if (severity === "warning" && sev !== "error" && sev !== "warning")
        continue;

      items.push({
        file: relPath.replace(/\\/g, "/"),
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: sev,
        message: d.message,
        source: d.source,
      });
    }
  }

  const limited = items.slice(0, 200);
  return { total: items.length, shown: limited.length, diagnostics: limited };
}

/** 获取 IDE 状态快照 */
export async function getStatus(): Promise<unknown> {
  const folders =
    vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const activeEditor = vscode.window.activeTextEditor;

  const allDiags = vscode.languages.getDiagnostics();
  let errorCount = 0;
  let warningCount = 0;
  for (const [, diags] of allDiags) {
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning)
        warningCount++;
    }
  }

  return {
    workspace: folders[0] || null,
    workspaceFolders: folders,
    activeEditor: activeEditor
      ? {
          path: activeEditor.document.uri.fsPath,
          language: activeEditor.document.languageId,
          lineCount: activeEditor.document.lineCount,
          isDirty: activeEditor.document.isDirty,
        }
      : null,
    diagnostics: { errors: errorCount, warnings: warningCount },
    extensions: vscode.extensions.all.filter(
      (e) => !e.id.startsWith("vscode."),
    ).length,
  };
}
