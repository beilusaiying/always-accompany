/**
 * edit-tools.ts -- 局部编辑工具（replace_lines / insert_at_line / fuzzy_edit）
 *
 * ═══════════════════════════════════════════════════════════════
 *  使用链路（每个 tool_call 的完整传导路径）
 * ═══════════════════════════════════════════════════════════════
 *
 * replaceLines:
 *   AI 需要精确替换文件中某行范围的内容
 *     → tool_call replace_lines { path, start_line, end_line, new_content }
 *     → resolveWorkspacePath + assertWritable 安全检查
 *     → FileCheckpoint.snapshotBeforeWrite 快照
 *     → 行范围替换（保持文件原始行尾风格）
 *     → autoSyntaxCheck 语法检查
 *     → 返回 { path, replacedRange, newRange, old_content, totalLines, message, syntaxCheck? }
 *     → 用户在编辑器中看到替换后的内容
 *
 * insertAtLine:
 *   AI 需要在文件指定行位置插入内容
 *     → tool_call insert_at_line { path, line, content }
 *     → resolveWorkspacePath + assertWritable 安全检查
 *     → FileCheckpoint.snapshotBeforeWrite 快照
 *     → 行位置插入（不覆盖现有行，保持原始行尾风格）
 *     → autoSyntaxCheck 语法检查
 *     → 返回 { path, insertedAt, insertedEnd, linesInserted, totalLines, message, syntaxCheck? }
 *     → 用户在编辑器中看到插入后的内容
 *
 * fuzzyEdit:
 *   AI 需要模糊匹配编辑文件（最常用的编辑工具）
 *     → tool_call fuzzy_edit { path, old_string, new_string, line_hint?, strict?, preview?, anchor_before?, anchor_after? }
 *     → resolveWorkspacePath + assertWritable 安全检查
 *     → 4 策略级联匹配：
 *       1. Exact（精确匹配，行尾规范化后 content.includes）
 *       2. LineTrimmed（去除行首尾空白后逐行比对）
 *       3. WsNormalized（行内空白归一后匹配，缩进/对齐容忍）
 *       4. BlockAnchor（首尾行锚定，中间允许 ±2 行偏移，≥3行）
 *     → 每策略均有唯一性校验（多处匹配无 line_hint → 报歧义，绝不擅自改第一处）
 *     → FileCheckpoint.snapshotBeforeWrite 快照
 *     → 写入 + verifyWrite 定位校验 + autoSyntaxCheck + detectCallSites
 *     → 返回 { success, path, strategy, matchLine, matchEnd, totalLines, message, verified, syntaxCheck?, callSites? }
 *     → 用户在编辑器中看到修改后的内容（自动跳转+高亮由 ToolExecutor.execute contextAnchor 统一处理）
 *
 *   纯锚点插入模式（anchor_before/anchor_after）：
 *     → 在两锚相邻处之间插入 new_string，不替换任何内容
 *     → 内容锚而非行号，抗漂移；唯一性校验防瞎插
 *
 * 相交：
 *   ← ToolExecutor.ts execute（_handlers 注册表路由到此）
 *   → tool-infra.ts resolveWorkspacePath/assertWritable/autoSyntaxCheck/verifyWrite/detectCallSites
 *   → FileCheckpoint.ts（写前快照）
 *   → constants.ts MAX_EDIT_FILE_SIZE
 */
import * as Diff from "diff";
import * as fs from "fs";
import * as path from "path";
import {
  resolveWorkspacePath,
  assertWritable,
  autoSyntaxCheck,
  verifyWrite,
  detectCallSites,
} from "../tool-infra";
import {
  MAX_EDIT_FILE_SIZE,
} from "../../constants";
import type { FileCheckpoint } from "../FileCheckpoint";

// ═══════════════════════════════════════════════════════════════
// fuzzy_edit 辅助方法
// ═══════════════════════════════════════════════════════════════

/** 行内空白归一：连续空白压成单空格 + trim，用于缩进/对齐容忍匹配 */
function _normalizeInnerWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** LineTrimmed：返回所有匹配的起始行下标（去前后空白后逐行比对），供唯一性校验 */
function _findAllTrimmedMatches(
  contentLines: string[],
  oldLines: string[],
): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const maxStart = contentLines.length - oldLines.length;
  for (let i = 0; i <= maxStart; i++) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== oldLines[j]) { matched = false; break; }
    }
    if (matched) out.push(i);
  }
  return out;
}

/** 行内空白归一匹配：返回所有匹配起始行下标（缩进/对齐差异容忍，比 trimmed 更宽） */
function _findAllWsNormMatches(
  contentLines: string[],
  oldLines: string[],
): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const normOld = oldLines.map((l) => _normalizeInnerWs(l));
  const maxStart = contentLines.length - oldLines.length;
  for (let i = 0; i <= maxStart; i++) {
    let matched = true;
    for (let j = 0; j < normOld.length; j++) {
      if (_normalizeInnerWs(contentLines[i + j]) !== normOld[j]) { matched = false; break; }
    }
    if (matched) out.push(i);
  }
  return out;
}

/** BlockAnchor：返回所有匹配（首行+尾行锚点定位块，中段长度允许 ±2 行偏移） */
function _findAllBlockAnchorMatches(
  contentLines: string[],
  oldLines: string[],
): Array<{ start: number; length: number }> {
  const out: Array<{ start: number; length: number }> = [];
  const firstAnchor = oldLines[0];
  const lastAnchor = oldLines[oldLines.length - 1];
  const expectedLen = oldLines.length;
  // ★ BUG-C：上界不能锁死在 expectedLen——内层允许块长 expectedLen-1~+3(中段±2)，
  //   首锚点贴近 EOF 的"短块"原会被 contentLines.length-expectedLen 截掉而漏匹配。
  //   内层已全程守界(i+endOffset<contentLines.length)，外层只需扫到文件末。
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstAnchor) continue;
    for (
      let endOffset = expectedLen - 2;
      endOffset <= expectedLen + 2 && i + endOffset < contentLines.length;
      endOffset++
    ) {
      if (endOffset < 1) continue;
      if (contentLines[i + endOffset].trim() === lastAnchor) {
        out.push({ start: i, length: endOffset + 1 });
        break;
      }
    }
  }
  return out;
}

/**
 * 唯一性消歧（防瞎插核心）：从多个候选起始行下标里定一个。
 * - 0 个 → {idx:-1}（继续降级或最终失败）
 * - 1 个 → {idx}
 * - >1 个 + lineHint>0 → 选离 lineHint 最近的 {idx}
 * - >1 个 + 无 hint → {idx:-1, ambiguous:[1基行号...]} 让调用方报歧义，绝不擅自改第一处
 */
function _pickUnique(starts: number[], lineHint: number): { idx: number; ambiguous?: number[] } {
  if (starts.length === 0) return { idx: -1 };
  if (starts.length === 1) return { idx: starts[0] };
  if (lineHint > 0) {
    const best = starts.reduce(
      (b, s) => (Math.abs(s + 1 - lineHint) < Math.abs(b + 1 - lineHint) ? s : b),
      starts[0],
    );
    return { idx: best };
  }
  return { idx: -1, ambiguous: starts.map((s) => s + 1) };
}

/** 查找最接近的匹配位置（用于错误提示） */
function _findClosestMatches(
  contentLines: string[],
  oldLines: string[],
  maxSuggestions: number,
): Array<{ line: number; similarity: number; preview: string }> {
  if (oldLines.length === 0) return [];

  const firstLine = oldLines[0];
  const suggestions: Array<{
    line: number;
    similarity: number;
    preview: string;
  }> = [];

  for (let i = 0; i < contentLines.length; i++) {
    const sim = _lineSimilarity(contentLines[i].trim(), firstLine);
    if (sim > 0.5) {
      suggestions.push({
        line: i + 1,
        similarity: Math.round(sim * 100),
        preview: contentLines[i].trim().substring(0, 80),
      });
    }
  }

  suggestions.sort((a, b) => b.similarity - a.similarity);
  return suggestions.slice(0, maxSuggestions);
}

/** 简单的行相似度计算（Jaccard 系数） */
function _lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ═══════════════════════════════════════════════════════════════
// 纯锚点插入
// ═══════════════════════════════════════════════════════════════

/**
 * 纯锚点插入（设计 v3 §6② inject_by_anchor）：在 anchor_before 与 anchor_after 相邻处之间插入内容。
 * - 给 before+after：定位「before 块紧接 after 块」的唯一缝隙，插在其间。
 * - 只给 before：插在 before 块唯一出现处之后；只给 after：插在其之前。
 * 逐行 trim 比对（缩进容忍）；多处匹配 → 报歧义不瞎插；带 checkpoint 回滚 + 写后语法检查。
 */
async function _anchorInsert(params: Record<string, unknown>, checkpoint: FileCheckpoint): Promise<unknown> {
  const filePath = params.path as string;
  const content = (params.new_string ?? params.content) as string;
  if (content === undefined || content === null) throw new Error("纯锚点插入缺少 new_string（要插入的内容）");

  const beforeRaw = (params.anchor_before as string) ?? "";
  const afterRaw = (params.anchor_after as string) ?? "";
  if (!beforeRaw.trim() && !afterRaw.trim()) throw new Error("纯锚点插入至少需要 anchor_before 或 anchor_after 之一");

  const absPath = resolveWorkspacePath(filePath);
  assertWritable(absPath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) throw new Error(`路径是目录: ${filePath}`);
  if (stat.size > MAX_EDIT_FILE_SIZE) throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

  const fileRaw = fs.readFileSync(absPath, "utf-8");
  const isCRLF = fileRaw.includes("\r\n");
  const lineEnding = isCRLF ? "\r\n" : "\n";
  const contentLines = (isCRLF ? fileRaw.replace(/\r\n/g, "\n") : fileRaw).split("\n");
  const beforeLines = beforeRaw ? beforeRaw.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()) : [];
  const afterLines = afterRaw ? afterRaw.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()) : [];
  const lineHint = typeof params.line_hint === "number" ? (params.line_hint as number) : 0;

  // 收集候选「插入点」行下标（插在该下标之前）。norm = 行规范化函数（降级链：先 trim，失配再 ws 归一）。
  // beforeLines/afterLines 已 trim；ws 归一兜底容忍缩进/对齐差异（设计 v3 §4.3 第4级，对标 opencode WhitespaceNormalized）。
  const collectInsertPoints = (norm: (s: string) => string): number[] => {
    const pts: number[] = [];
    const nBefore = beforeLines.map(norm);
    const nAfter = afterLines.map(norm);
    const matchAt = (nlines: string[], start: number): boolean => {
      if (start < 0 || start + nlines.length > contentLines.length) return false;
      for (let j = 0; j < nlines.length; j++) if (norm(contentLines[start + j]) !== nlines[j]) return false;
      return true;
    };
    if (nBefore.length && nAfter.length) {
      for (let i = 0; i + nBefore.length + nAfter.length <= contentLines.length; i++) {
        if (matchAt(nBefore, i) && matchAt(nAfter, i + nBefore.length)) pts.push(i + nBefore.length);
      }
    } else if (nBefore.length) {
      for (let i = 0; i + nBefore.length <= contentLines.length; i++) {
        if (matchAt(nBefore, i)) pts.push(i + nBefore.length);
      }
    } else {
      for (let i = 0; i + nAfter.length <= contentLines.length; i++) {
        if (matchAt(nAfter, i)) pts.push(i);
      }
    }
    return pts;
  };

  let insertPoints = collectInsertPoints((s) => s.trim());
  let anchorMatch = "trimmed";
  if (insertPoints.length === 0) {
    // 降级：行内空白/缩进归一容忍（仍要求唯一，下方 _pickUnique 把关，绝不瞎插）
    insertPoints = collectInsertPoints((s) => _normalizeInnerWs(s));
    anchorMatch = "ws_normalized";
  }

  if (insertPoints.length === 0) {
    // 失配 → 结构化候选（设计 §4.4：返回 suggestions，但绝不在失配处猜位置插）。
    const probeAnchor = beforeLines.length ? beforeLines : afterLines;
    const suggestions = _findClosestMatches(contentLines, probeAnchor, 3);
    return {
      success: false,
      error: "锚点不存在：anchor_before/anchor_after 在文件中未找到（trim + 空白归一两级比对均失配）。请 read_file 重取上下文原文，或扩大锚行数。",
      ...(suggestions.length ? { suggestions } : {}),
    };
  }
  const pick = _pickUnique(insertPoints, lineHint);
  if (pick.ambiguous) {
    return {
      success: false,
      error: `锚点不唯一：匹配 ${pick.ambiguous.length} 处（行 ${pick.ambiguous.join(", ")}）。请扩大 anchor_before/anchor_after 行数，或传 line_hint。绝不在歧义处瞎插。`,
      matchLines: pick.ambiguous,
    };
  }
  const at = pick.idx;

  checkpoint.snapshotBeforeWrite(filePath);
  checkpoint.recordOperation("fuzzy_edit", { path: filePath, strategy: "anchor_insert", matchLine: at + 1 });
  const insertLines = content.replace(/\r\n/g, "\n").split("\n");
  contentLines.splice(at, 0, ...insertLines);
  fs.writeFileSync(absPath, contentLines.join(lineEnding), "utf-8");
  const verifyResult = verifyWrite(absPath, content, { startLine: at, lineCount: insertLines.length });
  const syntaxCheck = autoSyntaxCheck(absPath);
  return {
    success: true,
    path: filePath,
    strategy: "anchor_insert",
    anchorMatch,
    matchLine: at + 1,
    insertedLines: insertLines.length,
    totalLines: contentLines.length,
    message: verifyResult.ok ? `✓ L${at + 1} 锚点插入${insertLines.length}行` : `✗ 写入异常: ${verifyResult.reason}`,
    verified: verifyResult.ok,
    ...(syntaxCheck ? { syntaxCheck } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════
// 导出工具函数
// ═══════════════════════════════════════════════════════════════

/** 替换文件指定行范围的内容 */
export async function replaceLines(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("缺少 path 参数");

  const startLine = params.start_line as number;
  const endLine = params.end_line as number;
  const newContent = params.new_content as string;

  if (!startLine || startLine < 1) throw new Error("start_line 必须 >= 1");
  if (!endLine || endLine < startLine)
    throw new Error("end_line 必须 >= start_line");
  if (newContent === undefined || newContent === null)
    throw new Error("缺少 new_content 参数");

  const absPath = resolveWorkspacePath(filePath);
  assertWritable(absPath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);

  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) throw new Error(`路径是目录: ${filePath}`);
  if (stat.size > MAX_EDIT_FILE_SIZE)
    throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

  checkpoint.snapshotBeforeWrite(filePath);
  checkpoint.recordOperation("replace_lines", {
    path: filePath,
    start_line: startLine,
    end_line: endLine,
  });

  const original = fs.readFileSync(absPath, "utf-8");
  // ★ 检测行尾风格，统一用 \n 分割处理，写回时恢复原始风格
  const isCRLF = original.includes("\r\n");
  const lineEnding = isCRLF ? "\r\n" : "\n";
  const normalizedContent = isCRLF ? original.replace(/\r\n/g, "\n") : original;
  const lines = normalizedContent.split("\n");

  if (startLine > lines.length)
    throw new Error(
      `start_line (${startLine}) 超出文件行数 (${lines.length})`,
    );

  const clampedEnd = Math.min(endLine, lines.length);
  const normalizedNew = isCRLF ? newContent.replace(/\r\n/g, "\n") : newContent;
  const newLines = normalizedNew.split("\n");
  const removedCount = clampedEnd - startLine + 1;

  // ★ 定点返回：捕获被删原文（前端真 diff 必需，旧版只返 range 致前端 diff 退化为占位符）
  const oldContent = lines.slice(startLine - 1, startLine - 1 + removedCount).join(lineEnding);

  lines.splice(startLine - 1, removedCount, ...newLines);
  fs.writeFileSync(absPath, lines.join(lineEnding), "utf-8");

  const newEnd = startLine + newLines.length - 1;
  const syntaxCheck = autoSyntaxCheck(absPath);
  return {
    path: filePath,
    replacedRange: `${startLine}-${clampedEnd}`,
    newRange: `${startLine}-${newEnd}`,
    old_content: oldContent,
    totalLines: lines.length,
    message: `L${startLine}-${clampedEnd} → L${startLine}-${newEnd} (${removedCount}→${newLines.length}行, 共${lines.length}行)`,
    ...(syntaxCheck ? { syntaxCheck } : {}),
  };
}

/** 在文件指定行位置插入内容 */
export async function insertAtLine(
  params: Record<string, unknown>,
  checkpoint: FileCheckpoint,
): Promise<unknown> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("缺少 path 参数");

  const line = params.line as number;
  const content = params.content as string;

  if (content === undefined || content === null)
    throw new Error("缺少 content 参数");

  const absPath = resolveWorkspacePath(filePath);
  assertWritable(absPath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);

  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) throw new Error(`路径是目录: ${filePath}`);
  if (stat.size > MAX_EDIT_FILE_SIZE)
    throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

  checkpoint.snapshotBeforeWrite(filePath);
  checkpoint.recordOperation("insert_at_line", {
    path: filePath,
    line,
  });

  const original = fs.readFileSync(absPath, "utf-8");
  // ★ 检测行尾风格，统一处理
  const isCRLF = original.includes("\r\n");
  const lineEnding = isCRLF ? "\r\n" : "\n";
  const normalizedContent = isCRLF ? original.replace(/\r\n/g, "\n") : original;
  const lines = normalizedContent.split("\n");
  const normalizedInsert = isCRLF ? content.replace(/\r\n/g, "\n") : content;
  const newLines = normalizedInsert.split("\n");

  let insertAt: number;
  let adjusted = false;
  if (!line || line <= 0 || line > lines.length + 1) {
    insertAt = lines.length;
    adjusted = !!line && line > 0;
  } else {
    insertAt = line - 1;
  }

  lines.splice(insertAt, 0, ...newLines);
  fs.writeFileSync(absPath, lines.join(lineEnding), "utf-8");

  const insertedEnd = insertAt + newLines.length;
  const syntaxCheck = autoSyntaxCheck(absPath);
  return {
    path: filePath,
    insertedAt: insertAt + 1,
    insertedEnd,
    linesInserted: newLines.length,
    totalLines: lines.length,
    message: `L${insertAt + 1}-${insertedEnd} 插入${newLines.length}行 (共${lines.length}行)${adjusted ? ` ⚠️行号${line}超出范围,已追加到末尾` : ""}`,
    ...(syntaxCheck ? { syntaxCheck } : {}),
  };
}

/**
 * 模糊匹配编辑文件内容
 * 策略1: 精确匹配（Exact）
 * 策略2: LineTrimmed（行首尾空白去除后匹配）
 * 策略2.5: WsNormalized（行内空白归一后匹配）
 * 策略3: BlockAnchor（首尾行锚定+中间替换，≥3行）
 */
export async function fuzzyEdit(params: Record<string, unknown>, checkpoint: FileCheckpoint): Promise<unknown> {
  const filePath = params.path as string;
  const oldString = params.old_string as string;
  const newString = params.new_string as string;
  // ★ strict模式：只做精确匹配，匹配失败直接报错（参考Claude Code Edit工具行为）
  const strict = params.strict === true;

  if (!filePath) throw new Error("缺少 path 参数");

  // ★ 纯锚点插入模式（设计 v3 §6② inject_by_anchor）：给 anchor_before+anchor_after，
  // 在两锚相邻处之间插入 new_string，不替换任何内容。内容锚而非行号，抗漂移；唯一性校验防瞎插。
  if (params.anchor_before !== undefined || params.anchor_after !== undefined) {
    return _anchorInsert(params, checkpoint);
  }

  if (oldString === undefined || oldString === null)
    throw new Error("缺少 old_string 参数");
  if (!oldString.trim())
    throw new Error("old_string 不能为空");
  if (newString === undefined || newString === null)
    throw new Error("缺少 new_string 参数");

  const absPath = resolveWorkspacePath(filePath);
  assertWritable(absPath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);

  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) throw new Error(`路径是目录: ${filePath}`);
  if (stat.size > MAX_EDIT_FILE_SIZE)
    throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

  const content = fs.readFileSync(absPath, "utf-8");

  // ★ 检测文件行尾风格（CRLF vs LF）
  const isCRLF = content.includes("\r\n");
  const lineEnding = isCRLF ? "\r\n" : "\n";

  // ★ 规范化 oldString/newString 的行尾，与文件保持一致
  const normalizedOld = isCRLF
    ? oldString.replace(/\r?\n/g, "\r\n")
    : oldString.replace(/\r\n/g, "\n");
  const normalizedNew = isCRLF
    ? newString.replace(/\r?\n/g, "\r\n")
    : newString.replace(/\r\n/g, "\n");

  // line_hint用于区分相同内容出现多次的场景（如同一行代码在多个函数里重复），让AI指定目标行附近优先匹配
  const lineHint = typeof params.line_hint === "number" ? (params.line_hint as number) : 0;

  // 策略1: 精确匹配（行尾规范化后）
  if (content.includes(normalizedOld)) {
    // 无条件收集所有精确匹配位置，用于唯一性校验（indexOf 只返回第一个，手动推进游标）
    const allIdxs: number[] = [];
    let sf = 0;
    while (sf < content.length) {
      const fi = content.indexOf(normalizedOld, sf);
      if (fi < 0) break;
      allIdxs.push(fi);
      sf = fi + 1;
    }
    let matchIdx = allIdxs[0];
    if (allIdxs.length > 1) {
      if (lineHint > 0) {
        // 多处匹配 + line_hint：选与 hint 行号距离最小的那处
        matchIdx = allIdxs.reduce((best, idx) => {
          const line = content.slice(0, idx).split("\n").length;
          const bestLine = content.slice(0, best).split("\n").length;
          return Math.abs(line - lineHint) < Math.abs(bestLine - lineHint) ? idx : best;
        }, allIdxs[0]);
      } else {
        // ★ 唯一性校验（防瞎插）：多处匹配且无 line_hint → 报歧义，绝不擅自改第一处
        const lines = allIdxs.map((idx) => content.slice(0, idx).split("\n").length);
        return {
          success: false,
          error: `匹配不唯一：old_string 精确匹配 ${allIdxs.length} 处（行 ${lines.join(", ")}）。请扩大 old_string 上下文使其唯一，或传 line_hint 指定目标行附近。绝不在歧义处瞎改。`,
          matchLines: lines,
        };
      }
    }
    // ★ Diff预览模式：不写入，用jsdiff生成精确差异
    if (params.preview === true) {
      const matchLine = content.slice(0, matchIdx).split("\n").length;
      const changes = Diff.diffLines(normalizedOld, normalizedNew);
      const diffLines: string[] = [];
      for (const ch of changes) {
        const lines = ch.value.replace(/\n$/, "").split("\n");
        for (const l of lines) {
          if (ch.added) diffLines.push("+ " + l);
          else if (ch.removed) diffLines.push("- " + l);
          else diffLines.push("  " + l);
        }
      }
      return {
        preview: true,
        path: filePath,
        matchLine,
        diff: diffLines,
        linesChanged: changes.filter((c) => c.added || c.removed).length,
        message: `预览：第${matchLine}行起。确认后去掉preview参数重新执行。`,
      };
    }
    checkpoint.snapshotBeforeWrite(filePath);
    checkpoint.recordOperation("fuzzy_edit", {
      path: filePath,
      strategy: "exact",
    });
    const matchLine = content.slice(0, matchIdx).split("\n").length;
    // 用slice拼接而非String.replace，因为replace只替换第一次出现，无法保证替换的是line_hint指定的那处
    const newContent = content.slice(0, matchIdx) + normalizedNew + content.slice(matchIdx + normalizedOld.length);
    fs.writeFileSync(absPath, newContent, "utf-8");
    // 写后验证
    const verifyResult = verifyWrite(absPath, normalizedNew);
    const syntaxCheck = autoSyntaxCheck(absPath);
    const callSites = detectCallSites(normalizedOld, normalizedNew, filePath);
    const oldLineCount = normalizedOld.split("\n").length;
    const newLineCount = normalizedNew.split("\n").length;
    return {
      success: true,
      path: filePath,
      strategy: "exact",
      matchLine,
      matchEnd: matchLine + newLineCount - 1,
      totalLines: newContent.split("\n").length,
      message: verifyResult.ok ? `✓ L${matchLine} 替换${oldLineCount}→${newLineCount}行` : `✗ 写入异常: ${verifyResult.reason}`,
      verified: verifyResult.ok,
      ...(syntaxCheck ? { syntaxCheck } : {}),
      ...(callSites ? { callSites } : {}),
    };
  }

  // ★ strict模式：精确匹配失败则直接报错，不降级到模糊策略
  if (strict) {
    const suggestions = _findClosestMatches(
      (isCRLF ? content.replace(/\r\n/g, "\n") : content).split("\n"),
      oldString.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()),
      3,
    );
    return {
      success: false,
      error: "strict模式：精确匹配失败，old_string在文件中不存在",
      suggestions,
    };
  }

  // 策略2: LineTrimmed（去除行首尾空白后匹配）
  // ★ 统一用 \n 分割（先去掉 \r），匹配后用文件原始行尾风格重新拼接
  const contentLF = isCRLF ? content.replace(/\r\n/g, "\n") : content;
  const oldLF = oldString.replace(/\r\n/g, "\n");
  const newLF = newString.replace(/\r\n/g, "\n");
  const oldLines = oldLF.split("\n").map((l) => l.trim());
  const contentLines = contentLF.split("\n");
  const trimStarts = _findAllTrimmedMatches(contentLines, oldLines);
  const trimPick = _pickUnique(trimStarts, lineHint);
  if (trimPick.ambiguous) {
    return {
      success: false,
      error: `匹配不唯一：old_string 经空白容错后匹配 ${trimPick.ambiguous.length} 处（行 ${trimPick.ambiguous.join(", ")}）。请扩大 old_string 上下文，或传 line_hint 指定目标行。绝不在歧义处瞎改。`,
      matchLines: trimPick.ambiguous,
    };
  }
  const matchStart = trimPick.idx;

  if (matchStart >= 0) {
    checkpoint.snapshotBeforeWrite(filePath);
    checkpoint.recordOperation("fuzzy_edit", {
      path: filePath,
      strategy: "trimmed",
      matchLine: matchStart + 1,
    });
    contentLines.splice(matchStart, oldLines.length, ...newLF.split("\n"));
    // ★ 用文件原始行尾风格重新拼接
    fs.writeFileSync(absPath, contentLines.join(lineEnding), "utf-8");
    const verifyResult = verifyWrite(absPath, newLF, { startLine: matchStart, lineCount: newLF.split("\n").length });
    const syntaxCheck = autoSyntaxCheck(absPath);
    const newLineCount = newLF.split("\n").length;
    return {
      success: true,
      path: filePath,
      strategy: "trimmed",
      matchLine: matchStart + 1,
      matchEnd: matchStart + newLineCount,
      totalLines: contentLines.length,
      message: verifyResult.ok ? `✓ L${matchStart + 1} 空白容错替换${oldLines.length}→${newLineCount}行` : `✗ 写入异常: ${verifyResult.reason}`,
      verified: verifyResult.ok,
      ...(syntaxCheck ? { syntaxCheck } : {}),
    };
  }

  // 策略2.5: 行内空白归一（缩进/对齐差异容忍，比 trimmed 更宽）+ 唯一性校验
  const wsStarts = _findAllWsNormMatches(contentLines, oldLines);
  const wsPick = _pickUnique(wsStarts, lineHint);
  if (wsPick.ambiguous) {
    return {
      success: false,
      error: `匹配不唯一：old_string 经缩进/空白归一后匹配 ${wsPick.ambiguous.length} 处（行 ${wsPick.ambiguous.join(", ")}）。请扩大 old_string 上下文，或传 line_hint 指定目标行。绝不在歧义处瞎改。`,
      matchLines: wsPick.ambiguous,
    };
  }
  if (wsPick.idx >= 0) {
    const wsStart = wsPick.idx;
    checkpoint.snapshotBeforeWrite(filePath);
    checkpoint.recordOperation("fuzzy_edit", {
      path: filePath,
      strategy: "ws_normalized",
      matchLine: wsStart + 1,
    });
    contentLines.splice(wsStart, oldLines.length, ...newLF.split("\n"));
    fs.writeFileSync(absPath, contentLines.join(lineEnding), "utf-8");
    const verifyResult = verifyWrite(absPath, newLF, { startLine: wsStart, lineCount: newLF.split("\n").length });
    const syntaxCheck = autoSyntaxCheck(absPath);
    const wsNewCount = newLF.split("\n").length;
    return {
      success: true,
      path: filePath,
      strategy: "ws_normalized",
      matchLine: wsStart + 1,
      matchEnd: wsStart + wsNewCount,
      totalLines: contentLines.length,
      message: verifyResult.ok ? `✓ L${wsStart + 1} 缩进容错替换${oldLines.length}→${wsNewCount}行` : `✗ 写入异常: ${verifyResult.reason}`,
      verified: verifyResult.ok,
      ...(syntaxCheck ? { syntaxCheck } : {}),
    };
  }

  // 策略3: BlockAnchor（首尾行锚定）+ 唯一性校验
  if (oldLines.length >= 3) {
    const anchorMatches = _findAllBlockAnchorMatches(contentLines, oldLines);
    const anchorPick = _pickUnique(anchorMatches.map((m) => m.start), lineHint);
    if (anchorPick.ambiguous) {
      return {
        success: false,
        error: `匹配不唯一：首尾行锚点匹配 ${anchorPick.ambiguous.length} 处（行 ${anchorPick.ambiguous.join(", ")}）。请扩大 old_string 上下文，或传 line_hint 指定目标行。绝不在歧义处瞎改。`,
        matchLines: anchorPick.ambiguous,
      };
    }
    const anchorResult = anchorPick.idx >= 0
      ? anchorMatches.find((m) => m.start === anchorPick.idx) ?? { start: -1, length: 0 }
      : { start: -1, length: 0 };
    if (anchorResult.start >= 0) {
      checkpoint.snapshotBeforeWrite(filePath);
      checkpoint.recordOperation("fuzzy_edit", {
        path: filePath,
        strategy: "anchor",
        matchLine: anchorResult.start + 1,
      });
      contentLines.splice(
        anchorResult.start,
        anchorResult.length,
        ...newLF.split("\n"),
      );
      // ★ 用文件原始行尾风格重新拼接
      fs.writeFileSync(absPath, contentLines.join(lineEnding), "utf-8");
      const verifyResult = verifyWrite(absPath, newLF, { startLine: anchorResult.start, lineCount: newLF.split("\n").length });
      const syntaxCheck = autoSyntaxCheck(absPath);
      const anchorNewCount = newLF.split("\n").length;
      return {
        success: true,
        path: filePath,
        strategy: "anchor",
        matchLine: anchorResult.start + 1,
        matchEnd: anchorResult.start + anchorNewCount,
        totalLines: contentLines.length,
        message: verifyResult.ok ? `✓ L${anchorResult.start + 1} 锚点替换${anchorResult.length}→${anchorNewCount}行` : `✗ 写入异常: ${verifyResult.reason}`,
        verified: verifyResult.ok,
        ...(syntaxCheck ? { syntaxCheck } : {}),
      };
    }
  }

  // 匹配失败：返回最接近的候选位置
  const suggestions = _findClosestMatches(contentLines, oldLines, 3);
  return {
    success: false,
    error: "无法匹配旧内容",
    suggestions,
  };
}
