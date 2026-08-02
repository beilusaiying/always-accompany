/**
 * tool-infra.ts -- 42 个 IDE 工具的共享基础设施层（纯函数 + 常量，无 class 状态）。
 *
 * ═══════════════════════════════════════════════════════════════
 *  功能链：所有工具的请求都经过这里的安全/日志/验证管道
 * ═══════════════════════════════════════════════════════════════
 *
 * 传导链路（每个 tool_call 都走这条路）：
 *   beilu 后端 AI 决定调工具
 *     → ideClient.mjs 发 WS tool_call
 *     → IdeWsServer.handleMessage case "tool_call"
 *     → extension.ts onToolCall → ToolExecutor.execute(req)
 *       → 【本模块】resolveWorkspacePath 校验路径安全 ← 越界就抛异常，工具不会执行
 *       → 【本模块】assertWritable 校验 AI 自改护栏 ← 禁写安全配置文件
 *       → _handlers[tool](params) 执行具体工具
 *       → 【本模块】autoSyntaxCheck 写后语法检查
 *       → 【本模块】verifyWrite 写后内容比对验证
 *       → 【本模块】postWriteDiagnostics LSP 诊断回注
 *       → 【本模块】buildContextAnchor 改动点上下文锚
 *       → 【本模块】ideOpLog 操作日志落盘
 *       → 【本模块】getResultHint/getErrorHint 结果提示
 *       → 【本模块】buildDebugInfo 调试信息
 *     → tool_result 回传给 beilu 后端
 *     → 写工具还推 editRecord 给前端 webview（用户看到 AI 改了哪里）
 *
 * 影响范围：
 *   - 路径安全：resolveWorkspacePath 是所有文件操作的唯一入口，越界即拒
 *   - AI 自改护栏：assertWritable 禁止 AI 修改 permission_level.json 等安全配置
 *   - 操作日志：ideOpLog 记录每次工具执行到 .beilu/_ide_operation_log.jsonl
 *   - 写后验证：autoSyntaxCheck(JS/JSON) + verifyWrite(内容级比对) 确保写入正确
 *   - LSP 诊断：写 .ts/.py/.go 等源码后自动附编译错误
 *   - 上下文锚：改动点前3后3行 + anchorText，抗行号漂移
 *
 * 相交：
 *   ← ToolExecutor.ts（execute 方法调用本模块所有函数）
 *   ← tools/*.ts（各工具实现 import 本模块的路径安全/语法检查/验证等）
 *   → constants.ts（引用截断阈值/日志上限等常量）
 *   → EditorReveal.ts（buildContextAnchor 的功能对标 revealAndHighlight）
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
// hint 文本单源+用户开关/覆盖（yonban.hints.*，链路3·代码零提示词）
import { hintText } from "./hintTexts";
import {
  STDOUT_TRUNCATE_THRESHOLD, STDOUT_HEAD_KEEP, STDOUT_TAIL_KEEP,
  IDE_OP_LOG_MAX, MAX_SEARCH_FILE_SIZE,
} from "../constants";

// ═══════════════════════════════════════════════════════════════
// [窗口id 0726] 轻量白盒埋点（与 代码cli/wb.mjs 孪生，console 桥版）：
// 打 "[wb:yonban.<node>:<event>]" 前缀行 → ConsoleCapture 捕获 → WS 广播回本体
// → monitor「运行时日志」面板，与 CLI 的 "[wb:cli.*]" 同族前缀、同一套过滤命中。
// 会话/线级事件把 key/_window_id 放进 data 参与归因（信封 chatid → params._window_id 链）。
// ═══════════════════════════════════════════════════════════════

export function wbT(node: string, event: string, data?: Record<string, unknown>): void {
  try {
    console.log(`[wb:yonban.${node}:${event}]${data ? " " + JSON.stringify(data) : ""}`);
  } catch { /* 埋点绝不影响主逻辑 */ }
}

export function wbD(node: string, event: string, ok: boolean, msg?: string, data?: Record<string, unknown>): boolean {
  try {
    const line = `[wb:yonban.${node}:${event}] ${ok ? "✓" : "⚠"}${msg ? " " + msg : ""}${data ? " " + JSON.stringify(data) : ""}`;
    if (ok) console.log(line);
    else console.warn(line);
  } catch { /* ignore */ }
  return ok;
}

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/** 递归遍历时统一跳过的目录（文件读写/搜索/列目录共用） */
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".beilu"]);

/**
 * 命令黑名单（纵深防御 by-design，本体侧也有独立检查）。
 * 单源约定：本清单 = 两侧「严重破坏类」永禁集，与本体 commandGate.mjs:DEFAULT_COMMAND_BLACKLIST 对齐。
 * 0715 凛倾拍板重分级：永禁只留可能严重破坏的（数据不可恢复/系统不可启动/公开泄露）；
 *   系统设置类（shutdown/reg/netsh/net user/taskkill /f/chmod 777）与 git push --force
 *   降档到本体灰名单（forced 审批档，上游 HITL 把关）——此处同步移除，否则 owner 审批放行也会被本副本死拦。
 * 维护规则：新增严重破坏类先加本体默认清单，再手动同步到此处。
 */
export const COMMAND_BLACKLIST = [
  /\brm\s+-rf\s+[\/\\]/i,
  /\bdel\s+\/[sq]/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bgit\s+push\s+(origin\s+)?main\b/i,
  /\bgit\s+push\s+(origin\s+)?master\b/i,
  /\bnpm\s+publish\b/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bdiskpart\b/i,
  /\bwget\b[^|]*\|\s*(ba)?sh/i,
  /\bpowershell\s+(-enc|-encodedcommand)/i,
  />\s*\/dev\/sd/i,
  /\brd\s+\/s\s+\/q\b/i,
  /\brmdir\s+\/s\s+\/q\b/i,
  /\bRemove-Item\s.*-Recurse/i,
  // 0715 增补（严重破坏类，与本体默认清单同步）：删卷影/改引导/擦盘/PS 格式化与清盘
  /\bvssadmin\s+delete\s+shadows/i,
  /\bbcdedit\b/i,
  /\bcipher\s+\/w/i,
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
  /\bgit\s+push\s+origin\b/i,
  /\bgit\s+push\s+https:\/\/github\.com\/beilusaiying\/always-accompany/i,
];

/** 折叠 git 全局选项（-C/-c/--git-dir 等），使子命令黑名单不被绕过 */
const _GIT_NORMALIZE_RE =
  /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)|--exec-path(?:=\S+)?|--bare|-P|--no-pager|--paginate|--no-replace-objects|--literal-pathspecs|--icase-pathspecs|--no-optional-locks))+/gi;

export function normalizeGitInvocations(command: string): string {
  if (!command || command.indexOf("git") === -1) return command;
  return command.replace(_GIT_NORMALIZE_RE, "git");
}

/** AI 自改护栏：禁写的安全关键文件模式 */
const _SELF_PROTECT_PATTERNS = [
  /[/\\]permission_level\.json$/i,
  /[/\\]command_config\.json$/i,
  /[/\\]\.claude[/\\]/i,
  /[/\\]CLAUDE\.md$/i,
  /[/\\]yonban_config\.json$/i,
];

/**
 * 写后 LSP 诊断的源码扩展名（排除 JS 家族——已有 autoSyntaxCheck 的 node --check 覆盖）
 */
export const LSP_SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".vue", ".svelte", ".kt", ".swift", ".scala",
]);

// ═══════════════════════════════════════════════════════════════
// 路径安全（R10 文件安全校验层）
// ═══════════════════════════════════════════════════════════════

export function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

/**
 * 将相对路径解析为工作区内绝对路径。越界（.. 逃逸 / 绝对路径跨盘）→ 抛异常，fail-closed。
 * 与 ideClient.mjs 的 workspaceRoot getter 对齐：门根==工具根，不分叉。
 */
export function resolveWorkspacePath(relPath: string): string {
  const wsRoot = getWorkspaceRoot();
  const resolved = path.isAbsolute(relPath) ? path.resolve(relPath) : path.resolve(wsRoot, relPath);
  const rel = path.relative(wsRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径安全限制: "${relPath}" 超出工作区范围 "${wsRoot}"`);
  }
  return resolved;
}

/** U9: AI 自改护栏 — 写工具禁写安全关键文件（fail-closed） */
export function assertWritable(absPath: string): void {
  const normalized = absPath.replace(/\\/g, "/");
  for (const pattern of _SELF_PROTECT_PATTERNS) {
    if (pattern.test(normalized)) {
      console.warn(`[YonBan][U9-self-protect] 拦截 AI 写受保护文件: ${absPath} (匹配 ${pattern})`);
      throw new Error(`🛡️ 安全保护: "${path.basename(absPath)}" 是系统关键配置文件，AI 禁止直接修改（防自改护栏）。如需变更请通过用户操作。`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 操作日志（滚动记录最近 500 条工具执行）
// ═══════════════════════════════════════════════════════════════

const _ideOpLogBuffer: Array<{t:string; tool:string; act:string; st:string; ms:number; d:Record<string,unknown>}> = [];
let _ideOpLogFile = "";

function _initLogFile(): string {
  if (_ideOpLogFile) return _ideOpLogFile;
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) return "";
  const logDir = path.join(ws, ".beilu");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  _ideOpLogFile = path.join(logDir, "_ide_operation_log.jsonl");
  return _ideOpLogFile;
}

export function ideOpLog(tool: string, action: string, detail: Record<string,unknown> = {}, status: "ok"|"fail"|"skip" = "ok", durationMs = 0) {
  const entry = { t: new Date().toISOString(), tool, act: action, st: status, ms: durationMs, d: detail };
  _ideOpLogBuffer.push(entry);
  if (_ideOpLogBuffer.length > IDE_OP_LOG_MAX) _ideOpLogBuffer.splice(0, _ideOpLogBuffer.length - IDE_OP_LOG_MAX);
  const logFile = _initLogFile();
  if (logFile) {
    try {
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
      if (_ideOpLogBuffer.length % 50 === 0) {
        try {
          const lines = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
          if (lines.length > IDE_OP_LOG_MAX) {
            fs.writeFileSync(logFile, lines.slice(-IDE_OP_LOG_MAX).join("\n") + "\n");
          }
        } catch {}
      }
    } catch {}
  }
}

export function getIdeOperationLog(n = 50): typeof _ideOpLogBuffer {
  return _ideOpLogBuffer.slice(-n);
}

// ═══════════════════════════════════════════════════════════════
// 写后验证
// ═══════════════════════════════════════════════════════════════

/**
 * 写后自动语法检查 — .js/.cjs/.mjs 用 node --check，.json 用 JSON.parse。
 * .ts 跳过（tsc 校验秒级开销，不适合写后实时）。
 * 环境问题（node 不在 PATH）返回 null 而非误报语法错。
 */
export function autoSyntaxCheck(absPath: string): { ok: boolean; error?: string } | null {
  const ext = path.extname(absPath).toLowerCase();
  if (ext !== ".js" && ext !== ".cjs" && ext !== ".mjs" && ext !== ".json") return null;
  try {
    if (ext === ".json") {
      const jsonContent = fs.readFileSync(absPath, "utf-8");
      JSON.parse(jsonContent);
      return { ok: true };
    }
    const syntaxResult = cp.spawnSync("node", ["--check", absPath], { timeout: 10000, windowsHide: true, encoding: "utf-8" });
    if (syntaxResult.error || syntaxResult.status === null) return null;
    if (syntaxResult.status !== 0) return { ok: false, error: (syntaxResult.stderr || "").substring(0, 500) };
    return { ok: true };
  } catch {
    return null;
  }
}

/**
 * 写后验证：确认新内容写到了目标位置（内容级比对，非 size 级）。
 * @param loc 写入落点 { startLine: 0基起始行, lineCount: 写入行数 }；省略则全文包含校验。
 */
export function verifyWrite(
  absPath: string,
  expectedContent: string,
  loc?: { startLine: number; lineCount: number },
): { ok: boolean; reason?: string } {
  try {
    const written = fs.readFileSync(absPath, "utf-8");
    const expLF = expectedContent.replace(/\r\n/g, "\n");
    if (!expLF.trim()) return { ok: true };
    const writtenLF = written.replace(/\r\n/g, "\n");
    if (loc) {
      const wLines = writtenLF.split("\n");
      const region = wLines.slice(loc.startLine, loc.startLine + loc.lineCount).join("\n");
      if (region === expLF) return { ok: true };
      return { ok: false, reason: "写入后定位校验失败：目标行段与替换内容不一致（落点错误或写入不完整）" };
    }
    if (writtenLF.includes(expLF)) return { ok: true };
    return { ok: false, reason: "写入后验证失败：文件中找不到替换后的内容" };
  } catch (err) {
    return { ok: false, reason: `写入后验证异常: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// LSP 诊断与上下文锚
// ═══════════════════════════════════════════════════════════════

/** 等待语言服务就绪（诊断/符号出现即视为就绪） */
export async function waitForLanguageServer(uri: vscode.Uri, maxWait = 2000): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const start = Date.now();
  let ready = false;
  let reason = "timeout";
  while (Date.now() - start < maxWait) {
    const diags = vscode.languages.getDiagnostics(uri);
    if (diags.length > 0) { ready = true; reason = `diags(${diags.length})`; break; }
    if (doc.languageId === "plaintext") { ready = true; reason = "plaintext"; break; }
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider", uri,
    );
    if (symbols && symbols.length > 0) { ready = true; reason = `symbols(${symbols.length})`; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  const elapsed = Date.now() - start;
  console.log(`[LSP-WAIT] ${path.basename(uri.fsPath)}: ${ready ? "ready" : "timeout"} in ${elapsed}ms (${reason}, lang=${doc.languageId})`);
}

/** 写后 LSP 诊断：取该文件 error 级诊断（只回注 error，避免既存 warning 噪声） */
export async function postWriteDiagnostics(
  absPath: string,
): Promise<Array<{ file: string; line: number; severity: number; message: string }> | null> {
  const ext = path.extname(absPath).toLowerCase();
  if (!LSP_SOURCE_EXTS.has(ext)) return null;
  const uri = vscode.Uri.file(absPath);
  await waitForLanguageServer(uri, 1500);
  const diags = vscode.languages.getDiagnostics(uri);
  if (!diags || diags.length === 0) return null;
  const wsRoot = getWorkspaceRoot();
  const rel = path.relative(wsRoot, absPath).replace(/\\/g, "/");
  const out: Array<{ file: string; line: number; severity: number; message: string }> = [];
  for (const d of diags) {
    if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
    out.push({ file: rel, line: d.range.start.line + 1, severity: 0, message: d.message });
    if (out.length >= 15) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * 改动点的相对上下文锚（抗行号漂移定位）。
 * 取改动块前3后3行 + 改动块首个非空行作 anchorText。
 */
export function buildContextAnchor(
  absPath: string,
  startLine: number,
  lineCount: number,
): { before: string[]; after: string[]; anchorText: string; lineHint: number } | null {
  try {
    const raw = fs.readFileSync(absPath, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = raw.split("\n");
    const s0 = Math.max(0, startLine - 1);
    const e0 = Math.min(lines.length - 1, s0 + Math.max(1, lineCount) - 1);
    const before = lines.slice(Math.max(0, s0 - 3), s0);
    const after = lines.slice(e0 + 1, Math.min(lines.length, e0 + 4));
    let anchorText = "";
    for (let i = s0; i <= e0 && i < lines.length; i++) {
      const t = (lines[i] || "").trim();
      if (t) { anchorText = t.slice(0, 120); break; }
    }
    return { before, after, anchorText, lineHint: startLine };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 文件搜索/遍历辅助
// ═══════════════════════════════════════════════════════════════

/** glob 转正则（支持 *, ?, {a,b} 模式） */
export function globToRegex(glob: string): RegExp {
  let pattern = glob.replace(/\{([^}]+)\}/g, (_, alts) => {
    return "(" + alts.split(",").map((a: string) => a.trim()).join("|") + ")";
  });
  pattern = pattern.replace(/[.+^$[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, "§DOUBLESTAR§");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/§DOUBLESTAR§/g, ".*");
  pattern = pattern.replace(/\?/g, ".");
  return new RegExp("^" + pattern + "$", "i");
}

/** 收集匹配 glob 的文件路径 */
export function collectFiles(dir: string, fileGlob: string, maxDepth: number): string[] {
  const nameRegex = fileGlob === "*" ? null : globToRegex(fileGlob);
  const result: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > maxDepth || result.length >= 2000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && (!nameRegex || nameRegex.test(entry.name))) {
        result.push(full);
      }
    }
  };
  walk(dir, 0);
  return result;
}

/** 转义正则元字符 */
export function escapeRegex(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ═══════════════════════════════════════════════════════════════
// 文档(xlsx)解析共享辅助（系统性重复收口 2026-07-13：原 file-tools/doc-tools 各养一份
// 同名同逻辑实现，注释称"避免循环依赖"——实际收进本共享层即无环）
// ═══════════════════════════════════════════════════════════════

/** XML 实体解码 */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 解析 workbook 的 sheet 名 → worksheet xml 路径（容忍属性顺序）。 */
export function mapXlsxSheets(wbXml: string, relsXml: string): Record<string, string> {
  const rels: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/\bId="([^"]+)"/)?.[1];
    const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels[id] = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^xl\//, "");
  }
  const map: Record<string, string> = {};
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = tag.match(/\bname="([^"]+)"/)?.[1];
    const rid = tag.match(/r:id="([^"]+)"/)?.[1];
    if (name && rid && rels[rid]) map[decodeXmlEntities(name)] = rels[rid];
  }
  return map;
}

/** 标识符按驼峰/蛇形/kebab 拆词，构造可同时命中各变体的正则 */
export function identifierFuzzyPattern(id: string): string {
  const words = String(id || "").split(/(?<=[a-z0-9])(?=[A-Z])|[_\-\s]+/).filter(Boolean);
  if (words.length <= 1) return id;
  return words.map((w) => {
    const first = w[0];
    const lower = escapeRegex(first.toLowerCase());
    const upper = escapeRegex(first.toUpperCase());
    const head = lower === upper ? `[${lower}]` : `[${lower}${upper}]`;
    return head + escapeRegex(w.slice(1));
  }).join("[_\\-]?");
}

/** 智能截断：保留头部+尾部，中间摘要 */
export function truncateOutput(s: string): string {
  if (s.length <= STDOUT_TRUNCATE_THRESHOLD) return s;
  const head = s.substring(0, STDOUT_HEAD_KEEP);
  const tail = s.substring(s.length - STDOUT_TAIL_KEEP);
  const totalLines = s.split("\n").length;
  const skipped = totalLines - head.split("\n").length - tail.split("\n").length;
  return head + `\n\n... (省略${skipped}行，共${totalLines}行) ...\n\n` + tail;
}

/** 搜索结果分页(cursor/nextCursor) + 体量预算提示(budgetHint) */
export function paginateSearch(
  allMatches: Array<{ file: string; line: number; content: string; context: string }>,
  meta: { pattern: string; directory: string; filePattern: string; engine: string },
  cursor: number,
  pageSize: number,
): unknown {
  const page = allMatches.slice(cursor, cursor + pageSize);
  const hasMore = allMatches.length > cursor + pageSize;
  const _chars = page.reduce((s, m) => s + (m.content || "").length + (m.context || "").length, 0);
  return {
    pattern: meta.pattern,
    directory: meta.directory,
    filePattern: meta.filePattern,
    matches: page,
    total: page.length,
    truncated: hasMore,
    nextCursor: hasMore ? cursor + pageSize : undefined,
    budgetHint: _chars > 8000 ? `本页约 ${Math.round(_chars / 1000)}k 字符偏大：建议缩小 pattern 或加 filePattern；翻页用 cursor=${cursor + pageSize}` : undefined,
    engine: meta.engine,
  };
}

/** 写后检测是否修改了函数签名，自动 grep 调用点提醒 */
export function detectCallSites(oldStr: string, newStr: string, editedFile: string): string[] | undefined {
  const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  const oldFuncs = new Set<string>();
  const newFuncs = new Set<string>();
  let m;
  while ((m = funcRegex.exec(oldStr)) !== null) oldFuncs.add(m[1] || m[2]);
  funcRegex.lastIndex = 0;
  while ((m = funcRegex.exec(newStr)) !== null) newFuncs.add(m[1] || m[2]);
  const modifiedFuncs: string[] = [];
  for (const fn of oldFuncs) {
    if (newFuncs.has(fn)) modifiedFuncs.push(fn);
  }
  if (modifiedFuncs.length === 0) return undefined;
  const wsRoot = getWorkspaceRoot();
  const callSites: string[] = [];
  for (const fn of modifiedFuncs.slice(0, 3)) {
    try {
      const rgResult = cp.spawnSync("rg", ["-l", "--max-count=5", fn, wsRoot, "--glob", "*.{js,ts,mjs,cjs,tsx,jsx}"], {
        timeout: 5000, windowsHide: true, encoding: "utf-8",
      });
      const result = rgResult.stdout || "";
      const files = result.trim().split("\n").filter(Boolean)
        .map((f) => path.relative(wsRoot, f).replace(/\\/g, "/"))
        .filter((f) => f !== editedFile);
      if (files.length > 0) {
        callSites.push(`${fn}() 在 ${files.length} 个其他文件中被调用: ${files.slice(0, 5).join(", ")}`);
      }
    } catch {}
  }
  return callSites.length > 0 ? callSites : undefined;
}

// ═══════════════════════════════════════════════════════════════
// 结果提示系统 — 帮助 AI 正确解读结果和决定下一步
// ═══════════════════════════════════════════════════════════════

// 文本单源=hintTexts.ts HINT_TEXTS（2026-07-08 链路3：文本与诊断逻辑分离——本函数只判"何时给
// 哪条"（条件分支=诊断逻辑归代码域），文本内容/用户开关/逐键覆盖全在 hintText()。
// yonban.hints.enabled=false 时 hintText 全返 null → 不附加任何 hint（用户可选择不要）。
export function getResultHint(tool: string, result: unknown, _params: Record<string, unknown>): string | null {
  const r = result as Record<string, unknown>;
  switch (tool) {
    case "search_files": {
      const matches = r.matches as unknown[] | undefined;
      if (!matches || matches.length === 0) return hintText("search_files.empty");
      return hintText("search_files.found", { n: matches.length });
    }
    case "search_by_name": {
      const results = r.results as unknown[] | undefined;
      if (!results || results.length === 0) return hintText("search_by_name.empty");
      return hintText("search_by_name.found", { n: results.length });
    }
    case "get_diagnostics": {
      const total = r.total as number | undefined;
      if (total === 0 || !total) return hintText("get_diagnostics.empty");
      return hintText("get_diagnostics.found", { n: total });
    }
    case "lint_code": {
      const errors = (r.errors as number | undefined) ?? 0;
      const warnings = (r.warnings as number | undefined) ?? 0;
      const eslintLayer = (r.eslintLayer as string | undefined) ?? "ok";
      const layerNote = eslintLayer.startsWith("failed")
        ? (hintText("lint_code.layer_failed", { layer: eslintLayer }) ?? "")
        : eslintLayer.startsWith("unavailable")
          ? (hintText("lint_code.layer_unavailable", { layer: eslintLayer }) ?? "")
          : "";
      if (errors > 0) return ((hintText("lint_code.errors", { n: errors, w: warnings }) ?? "") + layerNote) || null;
      if (warnings > 0) return ((hintText("lint_code.warnings", { n: warnings }) ?? "") + layerNote) || null;
      return ((hintText("lint_code.clean") ?? "") + layerNote) || null;
    }
    case "goto_definition": {
      if (r.success === false || r.message === "未找到定义") return hintText("goto_definition.not_found");
      return null;
    }
    case "find_references": {
      const refs = r.references as unknown[] | undefined;
      if (!refs || refs.length === 0) return hintText("find_references.empty");
      return hintText("find_references.found", { n: refs.length });
    }
    case "get_status": {
      if (!r.workspaceFolders) return hintText("get_status.empty");
      return null;
    }
    case "get_project_summary": {
      if (!r.name && !r.root) return hintText("get_project_summary.empty");
      return null;
    }
    case "smart_search": {
      const grep = r.grepResults as Record<string, unknown> | undefined;
      const ast = r.astResults as Record<string, unknown> | undefined;
      const grepEmpty = !grep || !(grep.matches as unknown[])?.length;
      const astEmpty = !ast || !(ast.matches as unknown[])?.length;
      if (grepEmpty && astEmpty) return hintText("smart_search.empty");
      return null;
    }
    case "write_file": {
      const verified = r.verified as boolean | undefined;
      const sc = r.syntaxCheck as Record<string, unknown> | undefined;
      const hints: string[] = [];
      if (verified === false) { const t = hintText("write_file.verify_failed"); if (t) hints.push(t); }
      if (sc && sc.ok === false) { const t = hintText("write_file.syntax_error", { error: ((sc.error as string) || "").substring(0, 100) }); if (t) hints.push(t); }
      if (hints.length === 0 && sc && sc.ok === true) { const t = hintText("write_file.ok"); if (t) hints.push(t); }
      return hints.length > 0 ? hints.join(" ") : null;
    }
    case "fuzzy_edit": {
      const sc = r.syntaxCheck as Record<string, unknown> | undefined;
      const cs = r.callSites as string[] | undefined;
      const hints: string[] = [];
      if (r.success === false) return hintText("fuzzy_edit.no_match");
      if (sc && sc.ok === false) { const t = hintText("fuzzy_edit.syntax_error", { error: ((sc.error as string) || "").substring(0, 100) }); if (t) hints.push(t); }
      if (cs && cs.length > 0) { const t = hintText("fuzzy_edit.call_sites", { n: cs.length, sites: cs.slice(0, 3).join(", ") }); if (t) hints.push(t); }
      if (hints.length === 0 && sc && sc.ok === true) { const t = hintText("fuzzy_edit.ok"); if (t) hints.push(t); }
      return hints.length > 0 ? hints.join(" ") : null;
    }
    case "replace_lines":
    case "insert_at_line": {
      const sc = r.syntaxCheck as Record<string, unknown> | undefined;
      if (sc && sc.ok === false) return hintText("line_edit.syntax_error", { error: ((sc.error as string) || "").substring(0, 100) });
      if (sc && sc.ok === true) return hintText("line_edit.ok");
      return null;
    }
    case "run_command":
    case "run_script": {
      const exitCode = r.exitCode as number | undefined;
      if (exitCode !== 0 && exitCode !== undefined) return hintText("run.exit_nonzero", { n: exitCode });
      return null;
    }
    default:
      return null;
  }
}

export function getErrorHint(tool: string, error: string, _params: Record<string, unknown>): string | null {
  if (error.includes("文件不存在")) return hintText("err.file_not_found");
  if (error.includes("目录不存在")) return hintText("err.dir_not_found");
  if (error.includes("缺少") && error.includes("参数")) return hintText("err.missing_param");
  if (error.includes("无法匹配旧内容")) return hintText("err.old_string_mismatch");
  switch (tool) {
    case "fuzzy_edit": return hintText("err.fuzzy_edit");
    case "run_command": return hintText("err.run_command");
    case "goto_definition":
    case "find_references": return hintText("err.ls_not_loaded");
    default: return null;
  }
}

/** 构建系统诊断信息 — 帮助 AI 判断是参数问题还是系统问题 */
export function buildDebugInfo(tool: string, params: Record<string, unknown>, ms: number, success: boolean, error?: string): Record<string, unknown> {
  const wsRoot = getWorkspaceRoot();
  const debug: Record<string, unknown> = { tool, ms, success, workspace: wsRoot };

  const inputPath = (params.path || params.cwd) as string | undefined;
  if (inputPath) {
    const isAbsolute = path.isAbsolute(inputPath);
    let resolved: string;
    try { resolved = resolveWorkspacePath(inputPath); } catch { resolved = inputPath; }
    const exists = fs.existsSync(resolved);
    debug.pathInfo = {
      input: inputPath, isAbsolute, resolved, exists,
      isRelative_reason: !isAbsolute ? `相对路径会被解析到工作区: ${wsRoot}` : undefined,
    };
    if (!exists) {
      const parentDir = path.dirname(resolved);
      debug.pathInfo = { ...(debug.pathInfo as Record<string, unknown>), parentExists: fs.existsSync(parentDir), parentDir };
    }
  }

  switch (tool) {
    case "goto_definition":
    case "find_references": {
      const editors = vscode.window.visibleTextEditors.map(e => e.document.uri.fsPath);
      debug.lsInfo = {
        openEditors: editors.length,
        targetFileOpen: inputPath ? editors.some(e => e.includes(path.basename(inputPath))) : false,
        hint: editors.length === 0 ? "没有打开的编辑器，LS可能未激活" : "LS应该已激活",
      };
      break;
    }
    case "search_by_name": {
      const pattern = params.pattern as string;
      if (pattern) {
        const namePattern = pattern.replace(/^(\*\*\/)+/, "");
        debug.globInfo = { originalPattern: pattern, namePattern, regex: globToRegex(namePattern || pattern).source };
      }
      break;
    }
    case "run_command": {
      const _isWin = process.platform === "win32";
      debug.platform = { os: process.platform, shell: _isWin ? "cmd.exe" : "/bin/sh", encoding: _isWin ? "GBK→UTF8 auto" : "UTF8" };
      break;
    }
    case "fuzzy_edit": {
      if (!success && error?.includes("无法匹配")) {
        const filePath = params.path as string;
        if (filePath) {
          try {
            const resolved = resolveWorkspacePath(filePath);
            if (fs.existsSync(resolved)) {
              const content = fs.readFileSync(resolved, "utf-8");
              debug.fileInfo = { exists: true, size: content.length, lines: content.split("\n").length };
              const oldStr = params.old_string as string;
              if (oldStr) {
                const idx = content.indexOf(oldStr.trim());
                debug.matchInfo = {
                  exactMatch: content.includes(oldStr),
                  trimmedMatch: idx >= 0,
                  hint: idx >= 0 ? "去掉首尾空白后能匹配到，可能是空格/换行差异" : "文件中找不到类似内容，可能文件已被修改过",
                };
              }
            }
          } catch {}
        }
      }
      break;
    }
  }

  if (!success && error) {
    if (error.includes("文件不存在") || error.includes("目录不存在") || error.includes("缺少") || error.includes("无法匹配")) {
      debug.errorType = "参数问题（检查路径/参数是否正确）";
    } else if (error.includes("未找到定义") || error.includes("Language Server")) {
      debug.errorType = "LS未就绪（等待或用search_files替代）";
    } else if (error.includes("timeout") || error.includes("超时")) {
      debug.errorType = "执行超时（增加timeout或简化命令）";
    } else {
      debug.errorType = "系统错误（可能是工具bug，报告给开发者）";
    }
  }

  return debug;
}
