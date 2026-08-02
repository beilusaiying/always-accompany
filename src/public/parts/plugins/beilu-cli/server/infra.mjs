/**
 * infra.mjs — 42 个工具的共享基础设施（从 YonBan tool-infra.ts 移植，去 vscode 依赖）
 *
 * 功能：路径安全 / 操作日志 / 写后验证 / 语法检查 / 上下文锚 / 搜索辅助 / 截断
 * 与 YonBan 原版的唯一差异：getWorkspaceRoot() 由外部注入，不读 vscode.workspace
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  STDOUT_TRUNCATE_THRESHOLD, STDOUT_HEAD_KEEP, STDOUT_TAIL_KEEP,
  IDE_OP_LOG_MAX, MAX_SEARCH_FILE_SIZE,
} from "./constants.mjs";
import { hintText as _hintText } from "./hints.mjs";

// ═══════════════════════════════════════════════════════════════
// 工作区根（外部注入）
// ═══════════════════════════════════════════════════════════════

let _workspaceRoot = process.cwd();

export function setWorkspaceRoot(root) {
  _workspaceRoot = root;
}

export function getWorkspaceRoot() {
  return _workspaceRoot;
}

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".beilu"]);

const _SELF_PROTECT_PATTERNS = [
  /[/\\]permission_level\.json$/i,
  /[/\\]command_config\.json$/i,
  /[/\\]\.claude[/\\]/i,
  /[/\\]CLAUDE\.md$/i,
  /[/\\]yonban_config\.json$/i,
];

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
  /\bvssadmin\s+delete\s+shadows/i,
  /\bbcdedit\b/i,
  /\bcipher\s+\/w/i,
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
  /\bgit\s+push\s+origin\b/i,
];

export const LSP_SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".vue", ".svelte", ".kt", ".swift", ".scala",
]);

// ═══════════════════════════════════════════════════════════════
// 路径安全
// ═══════════════════════════════════════════════════════════════

// ── 路径屏蔽纵深（AI 控制面板「路径配置(允许/屏蔽)」对 CLI 生效）──
// 数据源 = beilu-files-settings.json 各用户 blockedPaths 并集（server.mjs 启动/settings 变更时注入）。
// 只接 blocked（拒绝语义，从严并集确定）；allowed 白名单是 per-user 收紧机制，用户维在本体，
// 主裁决由本体 file_op 链按 user 精确执行——本处仅纵深。匹配口径对齐 beilu-files isPathAllowed:113
// （归一小写 + 边界形态 prefix+"/"，防裸前缀误拦兄弟目录）。
let _blockedPaths = [];
let _blockAnchor = "";

export function setPathGuards(blocked, anchor) {
  _blockedPaths = Array.isArray(blocked) ? blocked.filter((s) => typeof s === "string" && s.trim()) : [];
  _blockAnchor = anchor || "";
}

function _assertNotBlocked(absPath, origInput) {
  if (_blockedPaths.length === 0) return;
  const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const normalized = norm(absPath);
  for (const blocked of _blockedPaths) {
    // 条目 resolve 锚 = 项目根（与本体进程 CWD=项目根的 path.resolve 同锚），显式锚不依赖子进程 CWD
    const nb = norm(_blockAnchor ? path.resolve(_blockAnchor, blocked) : path.resolve(blocked));
    if (normalized === nb || normalized.startsWith(nb + "/")) {
      throw new Error(`🛡️ 路径屏蔽: "${origInput}" 命中「路径配置」屏蔽列表（${blocked}）`);
    }
  }
}

export function resolveWorkspacePath(relPath) {
  const wsRoot = getWorkspaceRoot();
  const resolved = path.isAbsolute(relPath) ? path.resolve(relPath) : path.resolve(wsRoot, relPath);
  const rel = path.relative(wsRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径安全限制: "${relPath}" 超出工作区范围 "${wsRoot}"`);
  }
  _assertNotBlocked(resolved, relPath); // 工作区内仍可被「路径配置」屏蔽（如屏蔽子目录/盘根工作区兜底）
  return resolved;
}

export function assertWritable(absPath) {
  const normalized = absPath.replace(/\\/g, "/");
  for (const pattern of _SELF_PROTECT_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`🛡️ 安全保护: "${path.basename(absPath)}" 是系统关键配置文件，AI 禁止直接修改。`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 操作日志
// ═══════════════════════════════════════════════════════════════

const _ideOpLogBuffer = [];
let _ideOpLogFile = "";

function _initLogFile() {
  if (_ideOpLogFile) return _ideOpLogFile;
  const ws = getWorkspaceRoot();
  if (!ws) return "";
  const logDir = path.join(ws, ".beilu");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  _ideOpLogFile = path.join(logDir, "_ide_operation_log.jsonl");
  return _ideOpLogFile;
}

export function ideOpLog(tool, action, detail = {}, status = "ok", durationMs = 0) {
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
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

export function getIdeOperationLog(n = 50) {
  return _ideOpLogBuffer.slice(-n);
}

// ═══════════════════════════════════════════════════════════════
// 写后验证
// ═══════════════════════════════════════════════════════════════

export function autoSyntaxCheck(absPath) {
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

export function verifyWrite(absPath, expectedContent, loc) {
  try {
    const written = fs.readFileSync(absPath, "utf-8");
    const expLF = expectedContent.replace(/\r\n/g, "\n");
    if (!expLF.trim()) return { ok: true };
    const writtenLF = written.replace(/\r\n/g, "\n");
    if (loc) {
      const wLines = writtenLF.split("\n");
      const region = wLines.slice(loc.startLine, loc.startLine + loc.lineCount).join("\n");
      if (region === expLF) return { ok: true };
      return { ok: false, reason: "写入后定位校验失败：目标行段与替换内容不一致" };
    }
    if (writtenLF.includes(expLF)) return { ok: true };
    return { ok: false, reason: "写入后验证失败：文件中找不到替换后的内容" };
  } catch (err) {
    return { ok: false, reason: `写入后验证异常: ${err?.message || String(err)}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI 模式 LSP 替代：tsc --noEmit + eslint --format json
// ═══════════════════════════════════════════════════════════════

export async function postWriteDiagnostics(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!LSP_SOURCE_EXTS.has(ext)) return null;

  const wsRoot = getWorkspaceRoot();
  const rel = path.relative(wsRoot, absPath).replace(/\\/g, "/");
  const out = [];

  // TypeScript: tsc --noEmit
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) {
    try {
      const tscResult = cp.spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false", absPath], {
        timeout: 15000, windowsHide: true, encoding: "utf-8", cwd: wsRoot,
      });
      if (tscResult.stdout) {
        const lines = tscResult.stdout.split("\n");
        for (const line of lines) {
          const m = line.match(/^(.+?)\((\d+),\d+\):\s*error\s+\w+:\s*(.+)/);
          if (m) {
            out.push({ file: rel, line: parseInt(m[2]), severity: 0, message: m[3].trim() });
            if (out.length >= 15) break;
          }
        }
      }
    } catch { /* tsc unavailable */ }
  }

  // ESLint
  try {
    const eslintResult = cp.spawnSync("npx", ["eslint", "--format", "json", "--no-warn", absPath], {
      timeout: 15000, windowsHide: true, encoding: "utf-8", cwd: wsRoot,
    });
    if (eslintResult.stdout) {
      try {
        const results = JSON.parse(eslintResult.stdout);
        if (Array.isArray(results)) {
          for (const r of results) {
            for (const msg of (r.messages || [])) {
              if (msg.severity === 2) {
                out.push({ file: rel, line: msg.line || 1, severity: 0, message: msg.message });
                if (out.length >= 15) return out;
              }
            }
          }
        }
      } catch { /* not json */ }
    }
  } catch { /* eslint unavailable */ }

  return out.length > 0 ? out : null;
}

// ═══════════════════════════════════════════════════════════════
// 上下文锚
// ═══════════════════════════════════════════════════════════════

export function buildContextAnchor(absPath, startLine, lineCount) {
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
// 搜索/遍历辅助
// ═══════════════════════════════════════════════════════════════

export function globToRegex(glob) {
  let pattern = glob.replace(/\{([^}]+)\}/g, (_, alts) => {
    return "(" + alts.split(",").map((a) => a.trim()).join("|") + ")";
  });
  pattern = pattern.replace(/[.+^$[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, "§DOUBLESTAR§");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/§DOUBLESTAR§/g, ".*");
  pattern = pattern.replace(/\?/g, ".");
  return new RegExp("^" + pattern + "$", "i");
}

export function collectFiles(dir, fileGlob, maxDepth) {
  const nameRegex = fileGlob === "*" ? null : globToRegex(fileGlob);
  const result = [];
  const walk = (d, depth) => {
    if (depth > maxDepth || result.length >= 2000) return;
    let entries;
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

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function mapXlsxSheets(wbXml, relsXml) {
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/\bId="([^"]+)"/)?.[1];
    const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels[id] = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^xl\//, "");
  }
  const map = {};
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = tag.match(/\bname="([^"]+)"/)?.[1];
    const rid = tag.match(/r:id="([^"]+)"/)?.[1];
    if (name && rid && rels[rid]) map[decodeXmlEntities(name)] = rels[rid];
  }
  return map;
}

export function identifierFuzzyPattern(id) {
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

export function truncateOutput(s) {
  if (s.length <= STDOUT_TRUNCATE_THRESHOLD) return s;
  const head = s.substring(0, STDOUT_HEAD_KEEP);
  const tail = s.substring(s.length - STDOUT_TAIL_KEEP);
  const totalLines = s.split("\n").length;
  const skipped = totalLines - head.split("\n").length - tail.split("\n").length;
  return head + `\n\n... (省略${skipped}行，共${totalLines}行) ...\n\n` + tail;
}

export function paginateSearch(allMatches, meta, cursor, pageSize) {
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

export function detectCallSites(oldStr, newStr, editedFile) {
  const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  const oldFuncs = new Set();
  const newFuncs = new Set();
  let m;
  while ((m = funcRegex.exec(oldStr)) !== null) oldFuncs.add(m[1] || m[2]);
  funcRegex.lastIndex = 0;
  while ((m = funcRegex.exec(newStr)) !== null) newFuncs.add(m[1] || m[2]);
  const modifiedFuncs = [];
  for (const fn of oldFuncs) {
    if (newFuncs.has(fn)) modifiedFuncs.push(fn);
  }
  if (modifiedFuncs.length === 0) return undefined;
  const wsRoot = getWorkspaceRoot();
  const callSites = [];
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
    } catch { /* rg unavailable */ }
  }
  return callSites.length > 0 ? callSites : undefined;
}

// ═══════════════════════════════════════════════════════════════
// CLI buildDebugInfo（无 vscode.window 依赖）
// ═══════════════════════════════════════════════════════════════

export function buildDebugInfo(tool, params, ms, success, error) {
  const wsRoot = getWorkspaceRoot();
  const debug = { tool, ms, success, workspace: wsRoot };

  const inputPath = params?.path || params?.cwd;
  if (inputPath) {
    const isAbsolute = path.isAbsolute(inputPath);
    let resolved;
    try { resolved = resolveWorkspacePath(inputPath); } catch { resolved = inputPath; }
    const exists = fs.existsSync(resolved);
    debug.pathInfo = { input: inputPath, isAbsolute, resolved, exists };
    if (!exists) {
      const parentDir = path.dirname(resolved);
      debug.pathInfo.parentExists = fs.existsSync(parentDir);
      debug.pathInfo.parentDir = parentDir;
    }
  }

  if (tool === "run_command") {
    const _isWin = process.platform === "win32";
    debug.platform = { os: process.platform, shell: _isWin ? "cmd.exe" : "/bin/sh", encoding: _isWin ? "GBK→UTF8 auto" : "UTF8" };
  }

  if (tool === "search_by_name" && params?.pattern) {
    const namePattern = params.pattern.replace(/^(\*\*\/)+/, "");
    debug.globInfo = { originalPattern: params.pattern, namePattern, regex: globToRegex(namePattern || params.pattern).source };
  }

  return debug;
}

export function normalizeGitInvocations(command) {
  if (!command || command.indexOf("git") === -1) return command;
  const re = /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)|--exec-path(?:=\S+)?|--bare|-P|--no-pager|--paginate|--no-replace-objects|--literal-pathspecs|--icase-pathspecs|--no-optional-locks))+/gi;
  return command.replace(re, "git");
}

// re-export hints
export { getResultHint, getErrorHint } from "./hints.mjs";
