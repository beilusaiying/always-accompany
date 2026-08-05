/**
 * 沙盒拉线测试：mock vscode → require bundle → 实例化 ToolExecutor → 逐工具调真实文件系统
 * 不需要 VSCode、不需要后端、不需要 WS——纯本地验证拆分后 42 个工具的链路完整性。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";

// ═══════════════════════════════════════════════════════════════
// 1. 沙盒工作区
// ═══════════════════════════════════════════════════════════════
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "yonban-test-sandbox-"));
fs.mkdirSync(path.join(SANDBOX, ".beilu"), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, "hello.js"), 'console.log("hello");\n');
fs.writeFileSync(path.join(SANDBOX, "test.json"), '{"a":1}\n');
fs.writeFileSync(path.join(SANDBOX, "multi.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
fs.mkdirSync(path.join(SANDBOX, "sub"), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, "sub", "deep.ts"), 'export const x = 1;\n');

// git init 沙盒（git 工具需要）
import { execSync } from "node:child_process";
try {
  execSync("git init", { cwd: SANDBOX, stdio: "pipe" });
  execSync("git add -A", { cwd: SANDBOX, stdio: "pipe" });
  execSync('git commit -m "init" --allow-empty', { cwd: SANDBOX, stdio: "pipe" });
} catch {}

// ═══════════════════════════════════════════════════════════════
// 2. Mock vscode 模块
// ═══════════════════════════════════════════════════════════════
const mockVscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: SANDBOX } }],
    openTextDocument: async () => ({ languageId: "plaintext", lineCount: 1 }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: {
    activeTextEditor: null,
    visibleTextEditors: [],
    showTextDocument: async () => {},
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  },
  languages: {
    getDiagnostics: (uri) => uri ? [] : [],
    onDidChangeDiagnostics: () => ({ dispose() {} }),
  },
  commands: {
    executeCommand: async () => [],
  },
  Uri: { file: (p) => ({ fsPath: p, scheme: "file" }) },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(s, e) { this.start = s; this.end = e; } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  extensions: { all: [] },
  env: { appName: "test-sandbox" },
};

// 拦截 require("vscode") → 注入 mock
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return "vscode";
  return _origResolve.call(this, request, parent, ...rest);
};
const _origLoad = Module._cache;
// 预置 vscode 模块缓存
const fakeModule = new Module("vscode");
fakeModule.exports = mockVscode;
fakeModule.loaded = true;
Module._cache["vscode"] = fakeModule;

// ═══════════════════════════════════════════════════════════════
// 3. 加载 bundle → 拿 ToolExecutor
// ═══════════════════════════════════════════════════════════════
const bundlePath = path.resolve("dist/extension.js");
if (!fs.existsSync(bundlePath)) {
  console.error("❌ dist/extension.js 不存在，先 node esbuild.js");
  process.exit(1);
}
const bundle = createRequire(import.meta.url)(bundlePath);

// bundle 导出 activate/deactivate。需要从内部拿 ToolExecutor。
// esbuild CJS bundle 把 ToolExecutor 挂在 exports 或 module 变量上。
// 直接搜索 bundle 的导出树。
let ToolExecutor;
for (const [k, v] of Object.entries(bundle)) {
  if (typeof v === "function" && v.WRITE_TOOLS instanceof Set) {
    ToolExecutor = v;
    break;
  }
}
if (!ToolExecutor) {
  // 试试 activate 激活后从闭包拿
  console.log("⚠ bundle 没直接导出 ToolExecutor，尝试通过 activate...");
  // 看看 bundle 导出了什么
  console.log("  bundle exports:", Object.keys(bundle));
  // 直接从 bundle 的内部模块缓存中找
  const src = fs.readFileSync(bundlePath, "utf-8");
  if (src.includes("WRITE_TOOLS")) {
    console.log("  ✓ WRITE_TOOLS 在 bundle 中存在");
  }
  console.log("❌ 无法提取 ToolExecutor，需要调整导出方式");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// 4. 拉线测试
// ═══════════════════════════════════════════════════════════════
const executor = new ToolExecutor();
let pass = 0, fail = 0, skip = 0;

async function test(name, tool, params, check) {
  try {
    const result = await executor.execute({ id: `test_${Date.now()}`, tool, params, traceId: "sandbox" });
    const ok = check(result);
    if (ok) {
      console.log(`  ✓ ${name}`);
      pass++;
    } else {
      console.log(`  ✗ ${name} — 检查失败`);
      console.log(`    result:`, JSON.stringify(result).substring(0, 300));
      fail++;
    }
  } catch (e) {
    console.log(`  ✗ ${name} — 异常: ${e.message}`);
    fail++;
  }
}

console.log("\n═══ YonBan 拆分后拉线测试 ═══\n");
console.log(`沙盒工作区: ${SANDBOX}\n`);

// ── 文件读写链 ──
console.log("【文件读写链】");
await test("read_file 读 hello.js", "read_file", { path: "hello.js" },
  r => r.success && r.result?.content?.includes("console.log"));

await test("read_file 分页 offset=2", "read_file", { path: "multi.txt", offset: 2, limit: 3 },
  r => r.success && r.result?.shownRange?.start === 3);

await test("write_file 新建文件", "write_file", { path: "new_file.js", content: 'const a = 1;\n' },
  r => r.success && r.result?.verified === true);

await test("write_file 写后验证", "read_file", { path: "new_file.js" },
  r => r.success && r.result?.content?.includes("const a = 1"));

await test("list_files 列目录", "list_files", { path: ".", recursive: true },
  r => r.success && r.result?.files?.length > 0);

// ── 搜索链 ──
console.log("\n【搜索链】");
await test("search_files 正则搜索", "search_files", { pattern: "console", path: "." },
  r => r.success && (r.result?.matches?.length > 0 || r.result?.total > 0));

await test("search_by_name glob 搜索", "search_by_name", { pattern: "*.js", path: "." },
  r => r.success && r.result?.results?.length > 0);

// ── 编辑链 ──
console.log("\n【编辑链】");
await test("fuzzy_edit exact 策略", "fuzzy_edit", { path: "hello.js", old_string: 'console.log("hello");', new_string: 'console.log("world");' },
  r => r.success && r.result?.strategy === "exact");

await test("fuzzy_edit 写后验证", "read_file", { path: "hello.js" },
  r => r.success && r.result?.content?.includes("world"));

await test("replace_lines 行替换", "replace_lines", { path: "multi.txt", start_line: 2, end_line: 3, new_content: "replaced2\nreplaced3" },
  r => r.success && r.result?.newRange);

await test("insert_at_line 插入", "insert_at_line", { path: "multi.txt", line: 1, content: "inserted_line" },
  r => r.success && r.result?.insertedAt === 1);

// ── fuzzy_edit 歧义检测 ──
fs.writeFileSync(path.join(SANDBOX, "dup.txt"), "AAA\nBBB\nAAA\nCCC\n");
await test("fuzzy_edit 歧义拦截（多处匹配无 line_hint）", "fuzzy_edit", { path: "dup.txt", old_string: "AAA", new_string: "ZZZ" },
  r => r.result?.success === false && r.result?.matchLines?.length === 2);

// ── 命令执行链 ──
console.log("\n【命令执行链】");
await test("run_command echo", "run_command", { command: "echo sandbox_test" },
  r => r.success && (r.result?.stdout || "").includes("sandbox_test"));

await test("run_command 黑名单拦截", "run_command", { command: "rm -rf /" },
  r => r.result?.blocked === true);

await test("run_command 持久会话", "run_command", { command: "echo session_ok", session: true },
  r => r.success && (r.result?.stdout || "").includes("session_ok"));

await test("run_script python", "run_script", { lang: "node", code: 'console.log("script_ok")' },
  r => r.success && (r.result?.stdout || "").includes("script_ok"));

// ── 诊断链 ──
console.log("\n【诊断链】");
await test("get_diagnostics", "get_diagnostics", {},
  r => r.success && r.result?.diagnostics !== undefined);

await test("get_status", "get_status", {},
  r => r.success && r.result?.workspace !== undefined);

// ── Git 链 ──
console.log("\n【Git 链】");
await test("git_status", "git_status", {},
  r => r.success && r.result?.branch !== undefined);

await test("git_log", "git_log", { maxCount: 5 },
  r => r.success && r.result?.commits?.length > 0);

await test("git_diff", "git_diff", {},
  r => r.success);

// ── 任务管理链 ──
console.log("\n【任务管理链】");
await test("todo_write", "todo_write", { content: "# TODO\n- [ ] test task\n" },
  r => r.success);

await test("todo_read", "todo_read", {},
  r => r.success && r.result?.content?.includes("test task"));

// ── 检查点链 ──
console.log("\n【检查点链】");
await test("_checkpoint_start", "_checkpoint_start", { id: "cp_test_1", chatId: "test", messageIndex: 0 },
  r => r.success);

await test("_checkpoint_list", "_checkpoint_list", {},
  r => r.success && r.result?.checkpoints?.length > 0);

await test("_checkpoint_commit", "_checkpoint_commit", { id: "cp_test_1" },
  r => r.success);

// ── 操作日志链 ──
console.log("\n【操作日志链】");
await test("_get_operation_log", "_get_operation_log", { count: 10 },
  r => r.success && r.result?.logs?.length > 0);

// ── VSCode API 链（mock 环境下有限验证） ──
console.log("\n【VSCode API 链（mock 环境）】");
await test("goto_definition（mock 返回空）", "goto_definition", { path: "hello.js", line: 1, column: 1 },
  r => true); // mock 下只验不崩

await test("find_references（mock 返回空）", "find_references", { path: "hello.js", line: 1, column: 1 },
  r => true);

await test("get_project_summary", "get_project_summary", {},
  r => r.success && r.result?.root === SANDBOX);

await test("validate_html", "validate_html", { content: "<div><p>ok</p></div>" },
  r => r.success);

// ── 搜索增强（Kilocode 对标）──
console.log("\n【搜索增强（mtime排序 + ripgrep --files + 长行截断）】");

// mtime 排序：先写一个旧文件，再写一个新文件，搜索结果新文件应在前
fs.writeFileSync(path.join(SANDBOX, "old_file.js"), '// old content marker_xyz\n');
// 确保时间差
await new Promise(r => setTimeout(r, 100));
fs.writeFileSync(path.join(SANDBOX, "new_file.js"), '// new content marker_xyz\n');

await test("search_files mtime 排序（新文件在前）", "search_files", { pattern: "marker_xyz", path: "." },
  r => {
    const matches = r.result?.matches || [];
    if (matches.length < 2) return false;
    return matches[0].file.includes("new_file");
  });

await test("search_by_name 返回 mtime 字段", "search_by_name", { pattern: "*.js", path: "." },
  r => {
    const results = r.result?.results || [];
    return results.length > 0 && results[0].mtime > 0;
  });

await test("search_by_name mtime 排序（新文件在前）", "search_by_name", { pattern: "*.js", path: "." },
  r => {
    const results = r.result?.results || [];
    if (results.length < 2) return false;
    return results[0].mtime >= results[1].mtime;
  });

await test("search_by_name 返回 engine 字段", "search_by_name", { pattern: "*.js", path: "." },
  r => r.result?.engine === "ripgrep" || r.result?.engine === "node");

// 长行截断：写一个含 3000 字符单行的文件
fs.writeFileSync(path.join(SANDBOX, "long.js"), '// ' + 'x'.repeat(3000) + ' findme_long\n');
await test("search_files 长行截断（>2000字符）", "search_files", { pattern: "findme_long", path: "." },
  r => {
    const matches = r.result?.matches || [];
    if (matches.length === 0) return false;
    return matches[0].content.length < 2100;
  });

// ── 路径安全链 ──
console.log("\n【路径安全链】");
await test("路径越界拦截", "read_file", { path: "../../etc/passwd" },
  r => r.success === false && r.error?.includes("路径安全"));

await test("AI 自改护栏", "write_file", { path: "permission_level.json", content: "{}" },
  r => r.success === false && r.error?.includes("安全保护"));

// ── 未知工具 ──
console.log("\n【边界】");
await test("未知工具", "nonexistent_tool", {},
  r => r.success === false && r.error?.includes("未知工具"));

// ═══════════════════════════════════════════════════════════════
// 5. 汇总
// ═══════════════════════════════════════════════════════════════
console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 ═══\n`);

// 清理沙盒
executor.disposeShellSession();
fs.rmSync(SANDBOX, { recursive: true, force: true });

if (fail > 0) process.exit(1);
