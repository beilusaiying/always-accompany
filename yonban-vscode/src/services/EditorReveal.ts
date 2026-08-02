/**
 * 编辑器跳转 — AI 改完文件后自动定位到修改行并高亮。不管工具执行（那是 ToolExecutor 的事）。
 *
 * 链路：ToolExecutor 写文件成功 → extension.ts 调 revealAndHighlight(absPath, matchLine, lineCount, anchorText) → 打开文件 + 跳转 + 3s 绿色高亮
 * 影响：打开 VSCode 编辑器标签页、创建临时 TextEditorDecorationType（3s 后 dispose）
 * 相交：← extension.ts(editRecord 推送后调用)  ← ToolExecutor._reveal(内部工具)
 *       → vscode.workspace.openTextDocument / vscode.window.showTextDocument
 *
 * 核心思路：用 anchorText 内容锚定位行号（抗行号漂移），matchLine 仅作回退。
 * 可通过 yonban.autoRevealOnEdit 配置项关闭。
 */
import * as vscode from "vscode";
import * as fs from "fs";

/**
 * 按内容锚 anchorText 在文件里定位**当前**行(抗行号漂移——行号变了也能靠内容找到)。
 * 找不到锚则回退 fallbackLine。供 revealAndHighlight + ToolExecutor._reveal 单源复用。返回 1-based 行号 + 是否命中。
 */
export function locateLineByAnchor(
  absPath: string,
  anchorText: string,
  fallbackLine: number
): { line: number; matched: boolean } {
  const at = (anchorText || "").trim();
  if (at) {
    try {
      const raw = fs.readFileSync(absPath, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = raw.split("\n");
      const idx = lines.findIndex((l) => l.includes(at));
      if (idx >= 0) return { line: idx + 1, matched: true };
    } catch {
      // 读失败 → 用回退行号
    }
  }
  return { line: fallbackLine > 0 ? fallbackLine : 1, matched: false };
}

/**
 * ★ 功能A：AI改完文件后自动打开 + 跳到修改行 + 3秒绿色高亮。
 * anchorText 提供时优先按内容锚定位当前行(抗行号漂移),matchLine 仅作回退。
 */
export async function revealAndHighlight(
  absPath: string,
  matchLine: number = 1,
  lineCount: number = 1,
  anchorText?: string
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("yonban");
  if (!cfg.get<boolean>("autoRevealOnEdit", true)) return;
  try {
    const located = locateLineByAnchor(absPath, anchorText ?? "", matchLine);
    const uri = vscode.Uri.file(absPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preserveFocus: true,
      preview: false,
    });
    const line = Math.max(0, located.line - 1);
    const endLine = Math.min(line + lineCount - 1, doc.lineCount - 1);
    const range = new vscode.Range(line, 0, endLine, doc.lineAt(endLine).text.length);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
      isWholeLine: true,
    });
    editor.setDecorations(decoration, [range]);
    setTimeout(() => decoration.dispose(), 3000);
  } catch {
    // 静默失败，不影响工具执行
  }
}