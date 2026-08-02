/**
 * vscode-tools.ts -- VSCode API 集成工具（LSP 查询 + 项目摘要 + 智能搜索 + lint）
 *
 * ═══════════════════════════════════════════════════════════════
 *  使用链路（每个 tool_call 的完整传导路径）
 * ═══════════════════════════════════════════════════════════════
 *
 * gotoDefinition:
 *   AI 需要查看符号定义位置
 *     → tool_call goto_definition { path, line, column? }
 *     → waitForLanguageServer 等待 LSP 就绪
 *     → vscode.executeDefinitionProvider 查询定义
 *     → 返回 { definitions: [{ file, line, column, endLine }] }
 *     → AI 据此跳转到目标定义
 *
 * findReferences:
 *   AI 需要查找符号的所有引用（调用点）
 *     → tool_call find_references { path, line, column? }
 *     → waitForLanguageServer 等待 LSP 就绪
 *     → vscode.executeReferenceProvider 查询引用
 *     → 返回 { references: [{ file, line, column }], total, truncated }
 *     → AI 据此了解修改影响范围
 *
 * getProjectSummary:
 *   AI 需要快速了解项目布局
 *     → tool_call get_project_summary
 *     → 读取 package.json/tsconfig.json + 遍历目录结构 + 统计文件类型
 *     → 返回 { root, name, type, directories, totalFiles, fileTypes, ... }
 *     → AI 据此选择搜索策略和工作方向
 *
 * smartSearch:
 *   AI 需要代码搜索，自动选最佳策略
 *     → tool_call smart_search { query, path? }
 *     → 按 query 形态自动选策略：$X 占位符→ast-grep / 代码字符→hybrid / 纯关键词→ripgrep
 *     → 返回 { query, strategy, grepResults?, astResults? }
 *
 * astSearch:
 *   AI 需要 AST 结构化搜索（比正则精确）
 *     → tool_call ast_search { pattern, lang?, path? }
 *     → cp.spawnSync("sg") 调用 ast-grep CLI
 *     → 返回 { pattern, lang, matches: [{ file, line, endLine, text }], total }
 *
 * validateHtml:
 *   AI 需要检查 HTML 标签闭合/嵌套
 *     → tool_call validate_html { path?, content? }
 *     → 优先 html-validate npm 包，回退正则启发式闭合检查
 *     → 返回 { valid, errors }
 *
 * lintCode:
 *   AI 需要代码静态分析
 *     → tool_call lint_code { path }
 *     → 三层检查：node --check(JS语法) + VSCode LSP diagnostics + ESLint(规则)
 *     → 返回 { path, errors, warnings, messages, eslintLayer }
 *
 * 相交：
 *   ← ToolExecutor.ts execute（_handlers 注册表路由到此）
 *   → tool-infra.ts（getWorkspaceRoot/resolveWorkspacePath/waitForLanguageServer/SKIP_DIRS）
 *   → vscode API（languages/commands/workspace/window）
 *   → 外部 CLI：ast-grep(sg) / node --check / eslint
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  getWorkspaceRoot,
  resolveWorkspacePath,
  waitForLanguageServer,
  SKIP_DIRS,
} from "../tool-infra";
import {
  REFERENCES_MAX, AST_MATCH_MAX, AST_GREP_TIMEOUT_MS,
  SYNTAX_CHECK_TIMEOUT_MS, ESLINT_TIMEOUT_MS, ESLINT_MSG_MAX,
  LINT_MSG_MAX, LSP_WRITE_SETTLE_MS,
} from "../../constants"; // 2026-07-13 收口：常量早已定义但本文件全程写字面量（漏 import 族）

/** 跳转到定义（利用VSCode语言服务） */
export async function gotoDefinition(params: Record<string, unknown>): Promise<unknown> {
  const filePath = params.path as string;
  const line = params.line as number;
  const column = (params.column as number) || 1;
  if (!filePath) throw new Error("缺少 path 参数");
  if (!line) throw new Error("缺少 line 参数");

  const absPath = resolveWorkspacePath(filePath);
  const uri = vscode.Uri.file(absPath);
  const position = new vscode.Position((line || 1) - 1, (column || 1) - 1);
  const wsRoot = getWorkspaceRoot();

  try {
    await waitForLanguageServer(uri);

    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeDefinitionProvider", uri, position,
    );
    if (!locations || locations.length === 0) {
      return { success: false, message: "未找到定义" };
    }
    return {
      definitions: locations.map((loc) => {
        // 兼容Location和LocationLink两种返回格式
        const anyLoc = loc as unknown as Record<string, unknown>;
        const locUri = (loc as vscode.Location).uri || (anyLoc as unknown as vscode.LocationLink).targetUri;
        const locRange = (loc as vscode.Location).range || (anyLoc as unknown as vscode.LocationLink).targetRange;
        if (!locUri) return { file: "unknown", line: 0, column: 0 };
        return {
        file: path.relative(wsRoot, locUri.fsPath).replace(/\\/g, "/"),
        line: (locRange?.start?.line ?? 0) + 1,
        column: (locRange?.start?.character ?? 0) + 1,
        endLine: (locRange?.end?.line ?? 0) + 1,
      };}),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `定义查找失败: ${msg}` };
  }
}

/** 查找所有引用（利用VSCode语言服务） */
export async function findReferences(params: Record<string, unknown>): Promise<unknown> {
  const filePath = params.path as string;
  const line = params.line as number;
  const column = (params.column as number) || 1;
  if (!filePath) throw new Error("缺少 path 参数");
  if (!line) throw new Error("缺少 line 参数");

  const absPath = resolveWorkspacePath(filePath);
  const uri = vscode.Uri.file(absPath);
  const position = new vscode.Position((line || 1) - 1, (column || 1) - 1);
  const wsRoot = getWorkspaceRoot();

  try {
    await waitForLanguageServer(uri);

    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider", uri, position,
    );
    if (!locations || locations.length === 0) {
      return { references: [], total: 0 };
    }
    const refs = locations.slice(0, REFERENCES_MAX).map((loc) => {
      // 兼容Location和LocationLink两种返回格式
      const anyLoc = loc as unknown as Record<string, unknown>;
      const locUri = (loc as vscode.Location).uri || (anyLoc as unknown as vscode.LocationLink).targetUri;
      const locRange = (loc as vscode.Location).range || (anyLoc as unknown as vscode.LocationLink).targetRange;
      if (!locUri) return { file: "unknown", line: 0, column: 0 };
      return {
        file: path.relative(wsRoot, locUri.fsPath).replace(/\\/g, "/"),
        line: (locRange?.start?.line ?? 0) + 1,
        column: (locRange?.start?.character ?? 0) + 1,
      };
    });
    return { references: refs, total: locations.length, truncated: locations.length > REFERENCES_MAX };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `引用查找失败: ${msg}` };
  }
}

/** 项目结构摘要（快速了解项目布局） */
export async function getProjectSummary(): Promise<unknown> {
  const wsRoot = getWorkspaceRoot();
  const summary: Record<string, unknown> = {
    root: wsRoot,
    name: path.basename(wsRoot),
  };

  // 读package.json
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

  // tsconfig检测
  if (fs.existsSync(path.join(wsRoot, "tsconfig.json"))) {
    summary.typescript = true;
  }

  // 顶层目录结构（2层）
  const dirs: string[] = [];
  const topEntries = fs.readdirSync(wsRoot, { withFileTypes: true });
  for (const entry of topEntries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const subEntries = fs.readdirSync(path.join(wsRoot, entry.name), { withFileTypes: true }).filter(
      (e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."),
    );
    if (subEntries.length > 0) {
      dirs.push(`${entry.name}/ (${subEntries.map((s) => s.name).join(", ")})`);
    } else {
      dirs.push(`${entry.name}/`);
    }
  }
  summary.directories = dirs;

  // 文件统计
  const fileExts: Record<string, number> = {};
  let totalFiles = 0;
  const countFiles = (dir: string, depth: number) => {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (e.isFile()) {
          totalFiles++;
          const ext = path.extname(e.name) || "(no ext)";
          fileExts[ext] = (fileExts[ext] || 0) + 1;
        } else if (e.isDirectory()) {
          countFiles(path.join(dir, e.name), depth + 1);
        }
      }
    } catch { /* skip */ }
  };
  countFiles(wsRoot, 0);
  summary.totalFiles = totalFiles;
  // 按数量排序取前10种文件类型
  summary.fileTypes = Object.entries(fileExts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, count]) => `${ext}: ${count}`);

  return summary;
}

/**
 * 智能搜索：按 query 形态自动选策略并合并结果。
 * - 含 ast-grep 占位符（$X）→ 纯 ast-grep（strategy=ast-grep）
 * - 含代码符号字符 → ripgrep 精确 + ast-grep 结构（strategy=hybrid）
 * - 纯关键词 → ripgrep（strategy=ripgrep）
 * 注：本方法不调用 VSCode 诊断，仅走 ripgrep / ast-grep。
 *
 * @param searchFilesFn - 注入 searchFiles 函数引用（来自 file-tools 或 ToolExecutor），
 *   避免循环依赖。签名：(params: Record<string, unknown>) => Promise<unknown>
 */
export async function smartSearch(
  params: Record<string, unknown>,
  searchFilesFn: (params: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const query = params.query as string;
  if (!query) throw new Error("缺少 query 参数");
  const searchPath = (params.path as string) || ".";
  const results: Record<string, unknown> = { query };

  // 判断搜索策略
  const looksLikeCode = /[\(\)\{\}\$\.\=\>]/.test(query); // 含代码字符
  const looksLikePattern = /\$[A-Z]/.test(query); // 含ast-grep占位符

  if (looksLikePattern) {
    // ast-grep模式搜索
    results.strategy = "ast-grep";
    results.astResults = await astSearch({ pattern: query, path: searchPath, lang: "js" });
  } else if (looksLikeCode) {
    // 同时用ripgrep精确搜索 + ast-grep结构搜索
    results.strategy = "hybrid";
    results.grepResults = await searchFilesFn({ pattern: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), path: searchPath, maxResults: 20 });
    try {
      results.astResults = await astSearch({ pattern: query, path: searchPath, lang: "js" });
    } catch { /* ast-grep可能不支持该模式 */ }
  } else {
    // 纯关键词 → ripgrep
    results.strategy = "ripgrep";
    results.grepResults = await searchFilesFn({ pattern: query, path: searchPath, maxResults: 30 });
  }

  // 0714 根因修（呈现层吞结果）：本工具此前只返回嵌套 grepResults/astResults，而本体注入格式化器
  // （ideClient formatToolResultsForInjection）按 search_files 同形只读【顶层】matches；strategy 又占了
  // 一行 extras 使零命中兜底不触发 → 命中结果被静默丢弃，AI 看到「策略:ripgrep」却 0 匹配。
  // 框架修=producer 输出形状与 search_files 对齐（matches 顶层），消费链零改；嵌套字段保留供程序化消费。
  {
    const flat: unknown[] = [];
    const g = results.grepResults as { matches?: unknown[]; total?: number } | undefined;
    const a = results.astResults as { matches?: unknown[]; total?: number } | undefined;
    if (g && Array.isArray(g.matches)) flat.push(...g.matches);
    if (a && Array.isArray(a.matches)) flat.push(...a.matches);
    results.matches = flat;
    results.total = (g?.total || 0) + (a?.total || 0);
  }
  return results;
}

/** ast-grep CLI 可执行名解析（0714 根因修）：
 *  ① 命令名此前写死 "sg"——npm 全局装的是 .cmd shim（Windows 下 spawnSync 无 shell 跑不了裸 "sg"），
 *    且新版官方推荐主命令名是 "ast-grep"（Linux 上 "sg" 与 util-linux setgroups 冲突）→ 装了也 ENOENT。
 *  ② spawnSync 失败【不 throw】：r.error=ENOENT 时 stdout 为空 → 旧代码 JSON.parse("[]") 静默返回
 *    0 匹配——「已装 ast-grep 0.42.1 却恒空返回」的病根（错被吞成空结果，AI 无从知晓）。
 *  候选逐个探测（Windows 补 .cmd/.exe 变体），找到即缓存。 */
let _astGrepBin: string | null | undefined; // undefined=未探测 string=已找到
function _resolveAstGrepBin(): string | null {
  if (typeof _astGrepBin === "string") return _astGrepBin;
  // 不缓存 null：后台自动安装完成后，下次调用应重新探测
  const candidates = process.platform === "win32"
    ? ["ast-grep", "ast-grep.cmd", "ast-grep.exe", "sg", "sg.cmd", "sg.exe"]
    : ["ast-grep", "sg"];
  for (const bin of candidates) {
    try {
      const probe = cp.spawnSync(bin, ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
      if (!probe.error && probe.status === 0) { _astGrepBin = bin; return bin; }
    } catch { /* 继续探测下一候选 */ }
  }
  return null;
}

/** AST结构化代码搜索（基于ast-grep，比正则精确） */
export async function astSearch(params: Record<string, unknown>): Promise<unknown> {
  const pattern = params.pattern as string;
  if (!pattern) throw new Error("缺少 pattern 参数（代码模式，如 'console.log($$$)'）");

  const lang = (params.lang as string) || "js";
  const searchPath = (params.path as string) || ".";
  const absPath = resolveWorkspacePath(searchPath);
  const wsRoot = getWorkspaceRoot();

  const bin = _resolveAstGrepBin();
  if (!bin) {
    return { success: false, error: "ast-grep 不可用（PATH 中找不到 ast-grep/sg，或安装后未重启 VSCode）。安装: npm install -g @ast-grep/cli" };
  }
  try {
    const sgResult = cp.spawnSync(bin, ["run", "-p", pattern, "--lang", lang, "--json", absPath], {
      timeout: AST_GREP_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "utf-8",
    });
    // spawn 层失败（不 throw）：透传真实原因，绝不折叠成 0 匹配。
    if (sgResult.error) {
      _astGrepBin = undefined; // 清缓存，下次重探测（可能 PATH 变了或后台安装完成）
      return { success: false, error: `ast-grep 执行失败: ${(sgResult.error as Error).message}`.substring(0, 300) };
    }
    const result = sgResult.stdout || "";
    // 非 0 退出且无输出：ast-grep pattern 语法错/参数错走这里——stderr 必须给 AI 看（旧代码吞成空结果）。
    if (sgResult.status !== 0 && !result.trim()) {
      const stderrMsg = String(sgResult.stderr || "").trim();
      if (stderrMsg) return { success: false, error: `ast-grep 报错(退出码${sgResult.status}): ${stderrMsg}`.substring(0, 400) };
      return { pattern, lang, matches: [], total: 0 };
    }
    const matches = JSON.parse(result || "[]");
    return {
      pattern,
      lang,
      matches: matches.slice(0, AST_MATCH_MAX).map((m: Record<string, unknown>) => {
        const range = m.range as Record<string, Record<string, number>> | undefined;
        const filePath = m.file as string || "";
        return {
          file: path.relative(wsRoot, filePath).replace(/\\/g, "/"),
          line: (range?.start?.line ?? 0) + 1,
          endLine: (range?.end?.line ?? 0) + 1,
          text: ((m.text as string) || "").substring(0, 200),
        };
      }),
      total: matches.length,
      truncated: matches.length > AST_MATCH_MAX,
    };
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: Buffer; message?: string };
    // exit code 1 = 无匹配（正常）
    if (err.status === 1) return { pattern, lang, matches: [], total: 0 };
    const msg = err.stderr?.toString("utf-8")?.trim() || err.message || "ast-grep执行失败";
    return { success: false, error: msg.substring(0, 300) };
  }
}

/** HTML/XML标签验证（检查闭合错误、嵌套问题） */
export async function validateHtml(params: Record<string, unknown>): Promise<unknown> {
  const filePath = params.path as string;
  const content = params.content as string;

  let htmlContent = content || "";
  if (!htmlContent && filePath) {
    const absPath = resolveWorkspacePath(filePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    htmlContent = fs.readFileSync(absPath, "utf-8");
  }
  if (!htmlContent && !filePath) throw new Error("缺少 path 或 content 参数");
  if (!htmlContent) throw new Error(`文件内容为空: ${filePath}`);

  try {
    // 用html-validate检查
    const result = cp.execSync(
      `node -e "const{HtmlValidate}=require('html-validate');const v=new HtmlValidate({extends:['html-validate:recommended'],rules:{'no-trailing-whitespace':'off','doctype-html':'off','require-sri':'off'}});const r=v.validateStringSync(require('fs').readFileSync(0,'utf-8'));console.log(JSON.stringify({valid:r.valid,errors:r.results.flatMap(f=>f.messages.map(m=>({line:m.line,col:m.column,msg:m.message,rule:m.ruleId}))).slice(0,${ESLINT_MSG_MAX})}))"`,
      { input: htmlContent, timeout: SYNTAX_CHECK_TIMEOUT_MS, windowsHide: true, encoding: "utf-8", cwd: getWorkspaceRoot() },
    );
    return JSON.parse(result);
  } catch (e: unknown) {
    // html-validate未安装时用简单正则检查闭合（启发式降级，非完整解析器）
    const openTags: string[] = [];
    // ★ BUG-F：① 标签名加连字符 → 识别自定义元素 <my-tag>（原 [a-zA-Z0-9]* 只匹到 my）。
    //   ② 属性段整体吞掉引号串(含其中的 >)，避免 `<a title="a>b">` 被 [^>]* 在引号内的 > 处提前截断 → 污染栈 → 误报闭合不匹配。
    const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^>'"])*\/?>/g;
    const selfClosing = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
    let m;
    const errors: string[] = [];
    while ((m = tagRegex.exec(htmlContent)) !== null) {
      const tag = m[1].toLowerCase();
      if (selfClosing.has(tag) || m[0].endsWith("/>")) continue;
      if (m[0].startsWith("</")) {
        if (openTags.length === 0 || openTags[openTags.length - 1] !== tag) {
          errors.push(`闭合不匹配: </${tag}> 位置${m.index}`);
        } else {
          openTags.pop();
        }
      } else {
        openTags.push(tag);
      }
    }
    for (const unclosed of openTags) errors.push(`未闭合: <${unclosed}>`);
    return {
      valid: errors.length === 0,
      errors,
      fallback: true,
      note: "html-validate 未安装，此为正则启发式闭合检查，对复杂HTML可能误报/漏报；如需精确校验请安装 html-validate",
    };
  }
}

/** 代码静态分析（node --check + VSCode diagnostics） */
export async function lintCode(params: Record<string, unknown>): Promise<unknown> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("缺少 path 参数");
  const absPath = resolveWorkspacePath(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);

  const messages: Array<{ line: number; type: string; message: string; rule: string }> = [];

  // 1. node --check 语法检查（JS/MJS/CJS）
  const ext = path.extname(absPath).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    try {
      cp.execSync(`node --check "${absPath}"`, {
        timeout: SYNTAX_CHECK_TIMEOUT_MS, windowsHide: true, encoding: "utf-8", stdio: "pipe",
      });
    } catch (syntaxErr: unknown) {
      const se = syntaxErr as { stderr?: string };
      const syntaxMsg = (se.stderr || "").trim();
      if (syntaxMsg) {
        const lineMatch = syntaxMsg.match(/:(\d+)/);
        messages.push({
          line: lineMatch ? parseInt(lineMatch[1]) : 1,
          type: "error",
          message: syntaxMsg.split("\n")[0],
          rule: "syntax",
        });
      }
    }
  }

  // 2. VSCode diagnostics（Language Server 检查结果）
  try {
    const uri = vscode.Uri.file(absPath);
    await vscode.workspace.openTextDocument(uri);
    // 等一小段时间让 Language Server 分析
    await new Promise(r => setTimeout(r, LSP_WRITE_SETTLE_MS));
    const diags = vscode.languages.getDiagnostics(uri);
    for (const d of diags.slice(0, LINT_MSG_MAX)) {
      messages.push({
        line: d.range.start.line + 1,
        type: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
        message: d.message,
        rule: d.source || "lsp",
      });
    }
  } catch { /* Language Server 不可用时跳过 */ }

  // 3. ESLint（第3层；失败不阻塞，但**真实状态**回报给调用方，不再静默吞掉）
  //   eslintLayer 取值：
  //     "ok"                 — ESLint 真实跑通（无论是否查出问题，messages 里见）
  //     "unavailable: ..."   — 本机无 ESLint / npx（功能缺失，非错误）
  //     "failed: ..."        — ESLint 调用真实失败（版本/flag/JSON 异常）；让 AI/用户看见第3层哑了
  let _eslintCfgFile = "";
  let eslintLayer = "ok";
  try {
    const eslintCwd = path.dirname(absPath);

    // ── 3a. 版本探测：决定用哪个 flag ──
    //   v8 用 --no-eslintrc（v9/v10 已删，传它会报 Invalid option）；
    //   v9+ 用 --no-config-lookup（v8 没有此 flag）。execFileSync 数组参数，不经 shell。
    let eslintMajor = 0;
    try {
      const verOut = cp.execFileSync("npx", ["eslint", "--version"], {
        timeout: ESLINT_TIMEOUT_MS, windowsHide: true, encoding: "utf-8", maxBuffer: 1024 * 1024, cwd: eslintCwd, stdio: "pipe", shell: true,
      });
      const vm = String(verOut).match(/v?(\d+)\./);
      if (vm) eslintMajor = parseInt(vm[1], 10);
    } catch (verErr: unknown) {
      // npx eslint --version 都跑不起来 = 本机无 ESLint，记为 unavailable（非 failed）
      eslintLayer = "unavailable: " + (((verErr as { stderr?: string; message?: string }).stderr || (verErr as { message?: string }).message || "eslint 不可用").toString().split("\n")[0].slice(0, 160));
    }

    if (eslintLayer === "ok") {
      // ── 3b. 经临时 flat-config 文件传规则，规避内联 --rule JSON 跨平台 shell 解析坑 ──
      _eslintCfgFile = path.join(os.tmpdir(), `yonban_eslint_${process.pid}_${Date.now()}.mjs`);
      fs.writeFileSync(
        _eslintCfgFile,
        `export default [{ rules: { "no-undef": "warn", "no-unreachable": "error", "no-dupe-keys": "error", "use-isnan": "error", "valid-typeof": "error" } }];\n`,
      );
      // 数组参数走 execFileSync，不拼 shell 字符串：路径/config 含空格或特殊字符也安全。
      // 仅 v8（含 eslintrc 体系）传 --no-eslintrc；v9+ 用 --no-config-lookup + flat config 文件。
      const args = ["eslint", "--format", "json"];
      if (eslintMajor > 0 && eslintMajor <= 8) {
        args.push("--no-eslintrc", "--rulesdir", eslintCwd); // v8 路径（理论兜底，本机为 v10）
        args.push("--config", _eslintCfgFile, absPath);
      } else {
        args.push("--no-config-lookup", "--config", _eslintCfgFile, absPath);
      }
      // stdio:"pipe" 把子进程 stderr 收进异常对象而非打到宿主控制台（原缺此项是两行红字噪声的来源）
      const eslintOpts = { timeout: ESLINT_TIMEOUT_MS, windowsHide: true, encoding: "utf-8" as const, maxBuffer: 1024 * 1024, cwd: eslintCwd, stdio: "pipe" as const, shell: true };

      let result = "";
      let nonZeroErr: { stdout?: string; stderr?: string } | null = null;
      try {
        result = cp.execFileSync("npx", args, eslintOpts) as unknown as string;
      } catch (e: unknown) {
        // ESLint 发现 lint 问题时以非 0 退出码结束，但 --format json 仍把结果写在 stdout。
        // 区分「有 lint 问题（stdout 是合法 JSON）」与「真失败（stdout 空/非 JSON）」。
        nonZeroErr = e as { stdout?: string; stderr?: string };
        result = nonZeroErr.stdout || "";
      }
      if (result && result.trim()) {
        const parsed = JSON.parse(result); // 解析失败 → 落到外层 catch 记 failed
        const eslintMsgs = parsed[0]?.messages || [];
        for (const m of eslintMsgs.slice(0, ESLINT_MSG_MAX)) {
          messages.push({
            line: m.line, type: m.severity === 2 ? "error" : "warning",
            message: m.message, rule: m.ruleId || "eslint",
          });
        }
      } else if (nonZeroErr) {
        // 非 0 退出但 stdout 无 JSON = 真失败（flag 非法/版本不符/进程异常），把 stderr 暴露出来
        eslintLayer = "failed: " + ((nonZeroErr.stderr || "ESLint 非零退出且无 JSON 输出").toString().split("\n")[0].slice(0, 200));
      }
    }
  } catch (eslintErr: unknown) {
    // 临时文件写入 / JSON.parse / 其它意外 → 记为 failed，不再静默吞掉
    eslintLayer = "failed: " + (((eslintErr as { message?: string }).message || "ESLint 层异常").toString().split("\n")[0].slice(0, 200));
  }
  finally { if (_eslintCfgFile) try { fs.unlinkSync(_eslintCfgFile); } catch { /* 临时配置清理失败忽略 */ } }

  // 去重（同一行同一message不重复）
  const seen = new Set<string>();
  const uniqueMessages = messages.filter(m => {
    const key = `${m.line}:${m.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    path: filePath,
    errors: uniqueMessages.filter(m => m.type === "error").length,
    warnings: uniqueMessages.filter(m => m.type === "warning").length,
    messages: uniqueMessages.slice(0, LINT_MSG_MAX),
    eslintLayer, // 第3层真实状态："ok" / "unavailable: ..." / "failed: ..."
  };
}
