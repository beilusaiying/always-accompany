/**
 * code-tools.mjs — 代码分析工具（从 YonBan vscode-tools.ts 移植）
 * 纯 Node.js 的工具直接移植，VSCode 依赖的用 CLI 替代：
 * - gotoDefinition: ripgrep + ast-grep 静态分析
 * - findReferences: ripgrep 搜索
 * - lintCode: node --check + eslint（去掉 LSP 层）
 * - getProjectSummary/smartSearch/astSearch/validateHtml: 原版就是纯 Node.js
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getWorkspaceRoot, resolveWorkspacePath, SKIP_DIRS } from "../infra.mjs";
import {
  REFERENCES_MAX, AST_MATCH_MAX, AST_GREP_TIMEOUT_MS,
  SYNTAX_CHECK_TIMEOUT_MS, ESLINT_TIMEOUT_MS, ESLINT_MSG_MAX, LINT_MSG_MAX,
} from "../constants.mjs";

// ═══════════════════════════════════════════════════════════════
// gotoDefinition — CLI 替代：读文件取符号 + ripgrep 搜定义
// ═══════════════════════════════════════════════════════════════

export async function gotoDefinition(params) {
  const filePath = params.path;
  const line = params.line;
  const column = params.column || 1;
  if (!filePath) throw new Error("缺少 path 参数");
  if (!line) throw new Error("缺少 line 参数");

  const absPath = resolveWorkspacePath(filePath);
  const wsRoot = getWorkspaceRoot();

  // 从文件中提取目标行的符号
  try {
    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const targetLine = lines[line - 1] || "";
    // 提取光标位置的标识符
    const beforeCursor = targetLine.slice(0, column - 1);
    const afterCursor = targetLine.slice(column - 1);
    const wordBefore = beforeCursor.match(/[a-zA-Z_$][\w$]*$/)?.[0] || "";
    const wordAfter = afterCursor.match(/^[a-zA-Z_$][\w$]*/)?.[0] || "";
    const symbol = wordBefore + wordAfter;

    if (!symbol) return { success: false, message: "未找到可识别的符号" };

    // 用 ripgrep 搜索定义模式
    const defPatterns = [
      `function\\s+${symbol}\\b`,
      `(const|let|var|class)\\s+${symbol}\\b`,
      `export\\s+(default\\s+)?(function|class|const|let|var)\\s+${symbol}\\b`,
      `${symbol}\\s*[:=]\\s*(function|class|\\()`,
    ];
    const pattern = defPatterns.join("|");

    const rgResult = cp.spawnSync("rg", [
      "-n", "--json", "-e", pattern, wsRoot,
      "--glob", "*.{js,ts,mjs,cjs,tsx,jsx,mts,cts}",
      "--glob", "!node_modules", "--glob", "!dist", "--glob", "!.git",
      "--max-count", "10",
    ], { timeout: 10000, windowsHide: true, encoding: "utf-8" });

    if (rgResult.error) return { success: false, error: "ripgrep 不可用" };

    const definitions = [];
    for (const jsonLine of (rgResult.stdout || "").split("\n")) {
      if (!jsonLine.trim()) continue;
      try {
        const obj = JSON.parse(jsonLine);
        if (obj.type !== "match") continue;
        const d = obj.data;
        const file = path.relative(wsRoot, d.path?.text || "").replace(/\\/g, "/");
        definitions.push({
          file,
          line: (d.line_number || 1),
          column: 1,
          text: (d.lines?.text || "").trim().slice(0, 200),
        });
      } catch { /* skip malformed json lines */ }
    }

    if (definitions.length === 0) {
      // fallback: try ast-grep
      const bin = _resolveAstGrepBin();
      if (bin) {
        try {
          const sgResult = cp.spawnSync(bin, ["run", "-p", `function ${symbol}($$$)`, "--lang", "js", "--json", wsRoot], {
            timeout: AST_GREP_TIMEOUT_MS, windowsHide: true, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024,
          });
          if (!sgResult.error && sgResult.stdout) {
            const matches = JSON.parse(sgResult.stdout || "[]");
            for (const m of matches.slice(0, 5)) {
              definitions.push({
                file: path.relative(wsRoot, m.file || "").replace(/\\/g, "/"),
                line: (m.range?.start?.line || 0) + 1,
                column: 1,
              });
            }
          }
        } catch { /* ast-grep fallback failed */ }
      }
    }

    if (definitions.length === 0) return { success: false, message: "未找到定义" };
    return { definitions };
  } catch (e) {
    return { success: false, error: `定义查找失败: ${e?.message || String(e)}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// findReferences — CLI 替代：ripgrep 搜索符号引用
// ═══════════════════════════════════════════════════════════════

export async function findReferences(params) {
  const filePath = params.path;
  const line = params.line;
  const column = params.column || 1;
  if (!filePath) throw new Error("缺少 path 参数");
  if (!line) throw new Error("缺少 line 参数");

  const absPath = resolveWorkspacePath(filePath);
  const wsRoot = getWorkspaceRoot();

  try {
    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const targetLine = lines[line - 1] || "";
    const beforeCursor = targetLine.slice(0, column - 1);
    const afterCursor = targetLine.slice(column - 1);
    const wordBefore = beforeCursor.match(/[a-zA-Z_$][\w$]*$/)?.[0] || "";
    const wordAfter = afterCursor.match(/^[a-zA-Z_$][\w$]*/)?.[0] || "";
    const symbol = wordBefore + wordAfter;

    if (!symbol) return { references: [], total: 0 };

    const rgResult = cp.spawnSync("rg", [
      "-n", "--json", "-w", symbol, wsRoot,
      "--glob", "*.{js,ts,mjs,cjs,tsx,jsx,mts,cts,vue,svelte}",
      "--glob", "!node_modules", "--glob", "!dist", "--glob", "!.git",
      "--max-count", "200",
    ], { timeout: 10000, windowsHide: true, encoding: "utf-8" });

    if (rgResult.error) return { success: false, error: "ripgrep 不可用" };

    const references = [];
    for (const jsonLine of (rgResult.stdout || "").split("\n")) {
      if (!jsonLine.trim()) continue;
      try {
        const obj = JSON.parse(jsonLine);
        if (obj.type !== "match") continue;
        const d = obj.data;
        references.push({
          file: path.relative(wsRoot, d.path?.text || "").replace(/\\/g, "/"),
          line: d.line_number || 1,
          column: 1,
        });
      } catch { /* skip */ }
    }

    return {
      references: references.slice(0, REFERENCES_MAX),
      total: references.length,
      truncated: references.length > REFERENCES_MAX,
    };
  } catch (e) {
    return { success: false, error: `引用查找失败: ${e?.message || String(e)}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// getProjectSummary — 原版就是纯 Node.js
// ═══════════════════════════════════════════════════════════════

export async function getProjectSummary() {
  const wsRoot = getWorkspaceRoot();
  const summary = { root: wsRoot, name: path.basename(wsRoot) };

  const pkgPath = path.join(wsRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      summary.type = "Node.js";
      summary.packageName = pkg.name;
      summary.version = pkg.version;
      summary.dependencies = Object.keys(pkg.dependencies || {}).length;
      summary.devDependencies = Object.keys(pkg.devDependencies || {}).length;
      summary.scripts = Object.keys(pkg.scripts || {});
    } catch { /* ignore */ }
  }
  if (fs.existsSync(path.join(wsRoot, "tsconfig.json"))) summary.typescript = true;

  const dirs = [];
  try {
    const topEntries = fs.readdirSync(wsRoot, { withFileTypes: true });
    for (const entry of topEntries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      try {
        const subEntries = fs.readdirSync(path.join(wsRoot, entry.name), { withFileTypes: true })
          .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."));
        dirs.push(subEntries.length > 0 ? `${entry.name}/ (${subEntries.map((s) => s.name).join(", ")})` : `${entry.name}/`);
      } catch { dirs.push(`${entry.name}/`); }
    }
  } catch { /* ignore */ }
  summary.directories = dirs;

  const fileExts = {};
  let totalFiles = 0;
  const countFiles = (dir, depth) => {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (e.isFile()) { totalFiles++; const ext = path.extname(e.name) || "(no ext)"; fileExts[ext] = (fileExts[ext] || 0) + 1; }
        else if (e.isDirectory()) countFiles(path.join(dir, e.name), depth + 1);
      }
    } catch { /* skip */ }
  };
  countFiles(wsRoot, 0);
  summary.totalFiles = totalFiles;
  summary.fileTypes = Object.entries(fileExts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ext, count]) => `${ext}: ${count}`);
  return summary;
}

// ═══════════════════════════════════════════════════════════════
// ast-grep 二进制解析（与原版相同）
// ═══════════════════════════════════════════════════════════════

let _astGrepBin;
function _resolveAstGrepBin() {
  if (typeof _astGrepBin === "string") return _astGrepBin;
  const candidates = process.platform === "win32"
    ? ["ast-grep", "ast-grep.cmd", "ast-grep.exe", "sg", "sg.cmd", "sg.exe"]
    : ["ast-grep", "sg"];
  for (const bin of candidates) {
    try {
      const probe = cp.spawnSync(bin, ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
      if (!probe.error && probe.status === 0) { _astGrepBin = bin; return bin; }
    } catch { /* next */ }
  }
  return null;
}

export async function astSearch(params) {
  const pattern = params.pattern;
  if (!pattern) throw new Error("缺少 pattern 参数");
  const lang = params.lang || "js";
  const searchPath = params.path || ".";
  const absPath = resolveWorkspacePath(searchPath);
  const wsRoot = getWorkspaceRoot();

  const bin = _resolveAstGrepBin();
  if (!bin) return { success: false, error: "ast-grep 不可用。安装: npm install -g @ast-grep/cli" };

  try {
    const sgResult = cp.spawnSync(bin, ["run", "-p", pattern, "--lang", lang, "--json", absPath], {
      timeout: AST_GREP_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "utf-8",
    });
    if (sgResult.error) {
      _astGrepBin = undefined;
      return { success: false, error: `ast-grep 执行失败: ${sgResult.error.message}`.substring(0, 300) };
    }
    const result = sgResult.stdout || "";
    if (sgResult.status !== 0 && !result.trim()) {
      const stderrMsg = String(sgResult.stderr || "").trim();
      if (stderrMsg) return { success: false, error: `ast-grep 报错(退出码${sgResult.status}): ${stderrMsg}`.substring(0, 400) };
      return { pattern, lang, matches: [], total: 0 };
    }
    const matches = JSON.parse(result || "[]");
    return {
      pattern, lang,
      matches: matches.slice(0, AST_MATCH_MAX).map((m) => ({
        file: path.relative(wsRoot, m.file || "").replace(/\\/g, "/"),
        line: (m.range?.start?.line ?? 0) + 1,
        endLine: (m.range?.end?.line ?? 0) + 1,
        text: (m.text || "").substring(0, 200),
      })),
      total: matches.length,
      truncated: matches.length > AST_MATCH_MAX,
    };
  } catch (e) {
    if (e?.status === 1) return { pattern, lang, matches: [], total: 0 };
    const msg = e?.stderr?.toString?.("utf-8")?.trim() || e?.message || "ast-grep执行失败";
    return { success: false, error: msg.substring(0, 300) };
  }
}

export async function smartSearch(params, searchFilesFn) {
  const query = params.query;
  if (!query) throw new Error("缺少 query 参数");
  const searchPath = params.path || ".";
  const results = { query };
  const looksLikeCode = /[\(\)\{\}\$\.\=\>]/.test(query);
  const looksLikePattern = /\$[A-Z]/.test(query);

  if (looksLikePattern) {
    results.strategy = "ast-grep";
    results.astResults = await astSearch({ pattern: query, path: searchPath, lang: "js" });
  } else if (looksLikeCode) {
    results.strategy = "hybrid";
    results.grepResults = await searchFilesFn({ pattern: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), path: searchPath, maxResults: 20 });
    try { results.astResults = await astSearch({ pattern: query, path: searchPath, lang: "js" }); } catch { /* ast-grep 可能不支持 */ }
  } else {
    results.strategy = "ripgrep";
    results.grepResults = await searchFilesFn({ pattern: query, path: searchPath, maxResults: 30 });
  }

  const flat = [];
  const g = results.grepResults;
  const a = results.astResults;
  if (g && Array.isArray(g.matches)) flat.push(...g.matches);
  if (a && Array.isArray(a.matches)) flat.push(...a.matches);
  results.matches = flat;
  results.total = (g?.total || 0) + (a?.total || 0);
  return results;
}

export async function validateHtml(params) {
  const filePath = params.path;
  const content = params.content;
  let htmlContent = content || "";
  if (!htmlContent && filePath) {
    const absPath = resolveWorkspacePath(filePath);
    if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);
    htmlContent = fs.readFileSync(absPath, "utf-8");
  }
  if (!htmlContent && !filePath) throw new Error("缺少 path 或 content 参数");
  if (!htmlContent) throw new Error(`文件内容为空: ${filePath}`);

  try {
    const result = cp.execSync(
      `node -e "const{HtmlValidate}=require('html-validate');const v=new HtmlValidate({extends:['html-validate:recommended'],rules:{'no-trailing-whitespace':'off','doctype-html':'off','require-sri':'off'}});const r=v.validateStringSync(require('fs').readFileSync(0,'utf-8'));console.log(JSON.stringify({valid:r.valid,errors:r.results.flatMap(f=>f.messages.map(m=>({line:m.line,col:m.column,msg:m.message,rule:m.ruleId}))).slice(0,${ESLINT_MSG_MAX})}))"`,
      { input: htmlContent, timeout: SYNTAX_CHECK_TIMEOUT_MS, windowsHide: true, encoding: "utf-8", cwd: getWorkspaceRoot() },
    );
    return JSON.parse(result);
  } catch {
    const openTags = [];
    const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^>'"])*\/?>/g;
    const selfClosing = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
    let m;
    const errors = [];
    while ((m = tagRegex.exec(htmlContent)) !== null) {
      const tag = m[1].toLowerCase();
      if (selfClosing.has(tag) || m[0].endsWith("/>")) continue;
      if (m[0].startsWith("</")) {
        if (openTags.length === 0 || openTags[openTags.length - 1] !== tag) errors.push(`闭合不匹配: </${tag}> 位置${m.index}`);
        else openTags.pop();
      } else openTags.push(tag);
    }
    for (const unclosed of openTags) errors.push(`未闭合: <${unclosed}>`);
    return { valid: errors.length === 0, errors, fallback: true, note: "html-validate 未安装，此为正则启发式闭合检查" };
  }
}

export async function lintCode(params) {
  const filePath = params.path;
  if (!filePath) throw new Error("缺少 path 参数");
  const absPath = resolveWorkspacePath(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);

  const messages = [];
  const ext = path.extname(absPath).toLowerCase();

  // Layer 1: node --check
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    try {
      cp.execSync(`node --check "${absPath}"`, { timeout: SYNTAX_CHECK_TIMEOUT_MS, windowsHide: true, encoding: "utf-8", stdio: "pipe" });
    } catch (syntaxErr) {
      const syntaxMsg = (syntaxErr?.stderr || "").trim();
      if (syntaxMsg) {
        const lineMatch = syntaxMsg.match(/:(\d+)/);
        messages.push({ line: lineMatch ? parseInt(lineMatch[1]) : 1, type: "error", message: syntaxMsg.split("\n")[0], rule: "syntax" });
      }
    }
  }

  // Layer 2: (skip LSP in CLI mode)

  // Layer 3: ESLint
  let _eslintCfgFile = "";
  let eslintLayer = "ok";
  try {
    const eslintCwd = path.dirname(absPath);
    let eslintMajor = 0;
    try {
      const verOut = cp.execFileSync("npx", ["eslint", "--version"], {
        timeout: ESLINT_TIMEOUT_MS, windowsHide: true, encoding: "utf-8", maxBuffer: 1024 * 1024, cwd: eslintCwd, stdio: "pipe", shell: true,
      });
      const vm = String(verOut).match(/v?(\d+)\./);
      if (vm) eslintMajor = parseInt(vm[1], 10);
    } catch (verErr) {
      eslintLayer = "unavailable: " + ((verErr?.stderr || verErr?.message || "eslint 不可用").toString().split("\n")[0].slice(0, 160));
    }

    if (eslintLayer === "ok") {
      _eslintCfgFile = path.join(os.tmpdir(), `beilu_cli_eslint_${process.pid}_${Date.now()}.mjs`);
      fs.writeFileSync(_eslintCfgFile,
        `export default [{ rules: { "no-undef": "warn", "no-unreachable": "error", "no-dupe-keys": "error", "use-isnan": "error", "valid-typeof": "error" } }];\n`);
      const args = ["eslint", "--format", "json"];
      if (eslintMajor > 0 && eslintMajor <= 8) {
        args.push("--no-eslintrc", "--rulesdir", eslintCwd, "--config", _eslintCfgFile, absPath);
      } else {
        args.push("--no-config-lookup", "--config", _eslintCfgFile, absPath);
      }
      let result = "", nonZeroErr = null;
      try {
        result = cp.execFileSync("npx", args, { timeout: ESLINT_TIMEOUT_MS, windowsHide: true, encoding: "utf-8", maxBuffer: 1024 * 1024, cwd: eslintCwd, stdio: "pipe", shell: true });
      } catch (e) { nonZeroErr = e; result = e?.stdout || ""; }
      if (result && result.trim()) {
        const parsed = JSON.parse(result);
        const eslintMsgs = parsed[0]?.messages || [];
        for (const m of eslintMsgs.slice(0, ESLINT_MSG_MAX)) {
          messages.push({ line: m.line, type: m.severity === 2 ? "error" : "warning", message: m.message, rule: m.ruleId || "eslint" });
        }
      } else if (nonZeroErr) {
        eslintLayer = "failed: " + ((nonZeroErr.stderr || "ESLint 非零退出且无 JSON 输出").toString().split("\n")[0].slice(0, 200));
      }
    }
  } catch (eslintErr) {
    eslintLayer = "failed: " + ((eslintErr?.message || "ESLint 层异常").toString().split("\n")[0].slice(0, 200));
  } finally { if (_eslintCfgFile) try { fs.unlinkSync(_eslintCfgFile); } catch { /* ignore */ } }

  const seen = new Set();
  const uniqueMessages = messages.filter(m => { const key = `${m.line}:${m.message}`; if (seen.has(key)) return false; seen.add(key); return true; });
  return {
    path: filePath,
    errors: uniqueMessages.filter(m => m.type === "error").length,
    warnings: uniqueMessages.filter(m => m.type === "warning").length,
    messages: uniqueMessages.slice(0, LINT_MSG_MAX),
    eslintLayer,
  };
}
