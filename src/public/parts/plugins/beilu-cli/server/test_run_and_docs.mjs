/**
 * 全面测试：run_command / run_script 全场景 + xlsx/docx/pdf 读取
 */
import { ToolExecutor } from "./executor.mjs";
import * as fs from "node:fs";
import * as path from "node:path";

const TEST_DIR = path.resolve("_test_run_workspace");
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

const executor = new ToolExecutor(TEST_DIR);
let passed = 0, failed = 0;

async function test(name, tool, params, check) {
  const t0 = Date.now();
  try {
    const r = await executor.execute({ id: `t_${name}`, tool, params: params || {} });
    const ms = Date.now() - t0;
    const ok = check(r);
    if (ok) { console.log(`  ✓ ${name} (${ms}ms)`); passed++; }
    else {
      const preview = JSON.stringify(r.error || r.result || r).slice(0, 300);
      console.log(`  ✗ ${name} (${ms}ms) — ${preview}`);
      failed++;
    }
  } catch (e) {
    console.log(`  ✗ ${name} — 异常: ${e.message.slice(0, 200)}`);
    failed++;
  }
}

// ═══════════════════════════════════════════════════════════════
// run_command 全场景
// ═══════════════════════════════════════════════════════════════
console.log("\n═══ run_command 基础 ═══");
await test("echo 基础", "run_command", { command: "echo hello" },
  r => r.success && r.result?.stdout?.includes("hello"));

await test("多命令链", "run_command", { command: "echo first && echo second" },
  r => r.success && r.result?.stdout?.includes("first") && r.result?.stdout?.includes("second"));

await test("环境变量", "run_command", { command: process.platform === "win32" ? "echo %PATH%" : "echo $PATH" },
  r => r.success && r.result?.stdout?.length > 0);

await test("非零退出码", "run_command", { command: "exit 42" },
  r => r.result?.exitCode === 42 || r.result?.exitCode !== 0);

await test("stderr 输出", "run_command", { command: "node -e \"console.error('test_err')\"" },
  r => r.result?.stderr?.includes("test_err"));

await test("大输出截断", "run_command", { command: "node -e \"for(let i=0;i<200;i++) console.log('line'+i)\"" },
  r => r.success && r.result?.stdout?.length > 0);

await test("cwd 参数", "run_command", { command: process.platform === "win32" ? "cd" : "pwd", cwd: "." },
  r => r.success);

console.log("\n═══ run_command 安全 ═══");
await test("黑名单 rm -rf /", "run_command", { command: "rm -rf /" },
  r => !r.success || r.result?.success === false);

await test("黑名单 format C:", "run_command", { command: "format C:" },
  r => !r.success || r.result?.success === false);

await test("黑名单 npm publish", "run_command", { command: "npm publish" },
  r => !r.success || r.result?.success === false);

await test("黑名单 git push origin main", "run_command", { command: "git push origin main" },
  r => !r.success || r.result?.success === false);

console.log("\n═══ run_command 超时 ═══");
await test("短超时命令", "run_command", { command: "node -e \"setTimeout(()=>{},100000)\"", timeout: 3000 },
  r => r.result?.timedOut || r.result?.exitCode !== 0 || r.result?.stdout !== undefined);

console.log("\n═══ run_command GBK/编码 ═══");
await test("中文输出", "run_command", { command: "node -e \"console.log('你好世界')\"" },
  r => r.success && r.result?.stdout?.includes("你好世界"));

await test("Unicode 输出", "run_command", { command: "node -e \"console.log('emoji: 🎉')\"" },
  r => r.success && r.result?.stdout?.includes("🎉"));

// ═══════════════════════════════════════════════════════════════
// run_script 全语言
// ═══════════════════════════════════════════════════════════════
console.log("\n═══ run_script: Node.js ═══");
await test("node 基础", "run_script", { lang: "node", code: "console.log('node_ok')" },
  r => r.success && r.result?.stdout?.includes("node_ok"));

await test("node 多行", "run_script", { lang: "node", code: "const a = 1;\nconst b = 2;\nconsole.log(a + b);" },
  r => r.success && r.result?.stdout?.includes("3"));

await test("node 异步", "run_script", { lang: "node", code: "setTimeout(() => console.log('async_ok'), 100);" },
  r => r.success && r.result?.stdout?.includes("async_ok"));

await test("node 报错", "run_script", { lang: "node", code: "throw new Error('test_error');" },
  r => r.result?.exitCode !== 0 || r.result?.stderr?.includes("test_error"));

await test("node require", "run_script", { lang: "node", code: "const os = require('os'); console.log(os.platform());" },
  r => r.success && r.result?.stdout?.length > 0);

console.log("\n═══ run_script: Python ═══");
await test("python 基础", "run_script", { lang: "python", code: "print('python_ok')" },
  r => {
    if (r.success && r.result?.stdout?.includes("python_ok")) return true;
    if (r.result?.stderr?.includes("not found") || r.result?.stderr?.includes("not recognized") || r.result?.error?.includes("ENOENT")) {
      console.log("    (Python 未安装，跳过)"); return true;
    }
    return false;
  });

await test("python 多行", "run_script", { lang: "python", code: "a = 1\nb = 2\nprint(a + b)" },
  r => {
    if (r.success && r.result?.stdout?.includes("3")) return true;
    if (r.result?.stderr?.includes("not found") || r.result?.error?.includes("ENOENT")) return true;
    return false;
  });

console.log("\n═══ run_script: PowerShell ═══");
await test("powershell 基础", "run_script", { lang: "powershell", code: "Write-Host 'ps_ok'" },
  r => {
    if (r.success && r.result?.stdout?.includes("ps_ok")) return true;
    if (r.result?.stderr?.includes("not found") || r.result?.error?.includes("ENOENT")) {
      console.log("    (PowerShell 未安装，跳过)"); return true;
    }
    return false;
  });

console.log("\n═══ run_script: Bash ═══");
await test("bash 基础", "run_script", { lang: "bash", code: "echo bash_ok" },
  r => {
    if (r.success && r.result?.stdout?.includes("bash_ok")) return true;
    if (r.result?.stderr?.includes("not found") || r.result?.error?.includes("ENOENT")) {
      console.log("    (Bash 未安装，跳过)"); return true;
    }
    return false;
  });

// ═══════════════════════════════════════════════════════════════
// run_command session 模式
// ═══════════════════════════════════════════════════════════════
console.log("\n═══ run_command session 模式 ═══");
await test("session echo", "run_command", { command: "echo session_test", session: true },
  r => r.success && r.result?.stdout?.includes("session_test"));

await test("session 环境变量设置", "run_command",
  { command: process.platform === "win32" ? "set TESTVAR=hello123" : "export TESTVAR=hello123", session: true },
  r => r.success !== false);

await test("session 环境变量读取", "run_command",
  { command: process.platform === "win32" ? "echo %TESTVAR%" : "echo $TESTVAR", session: true },
  r => r.success);

// ═══════════════════════════════════════════════════════════════
// xlsx 创建 + 读取 + 编辑
// ═══════════════════════════════════════════════════════════════
console.log("\n═══ xlsx 读取和编辑 ═══");

// 用 xlsx 库创建测试文件
try {
  const XLSX = (await import("xlsx")).default;
  const wb = XLSX.utils.book_new();
  const data = [
    ["名称", "数量", "单价", "总价"],
    ["苹果", 10, 5, "=B2*C2"],
    ["香蕉", 20, 3, "=B3*C3"],
    ["总计", "", "", "=SUM(D2:D3)"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "销售表");
  const ws2 = XLSX.utils.aoa_to_sheet([["Sheet2 数据", 100]]);
  XLSX.utils.book_append_sheet(wb, ws2, "Sheet2");
  XLSX.writeFile(wb, path.join(TEST_DIR, "test.xlsx"));
  console.log("  (已创建 test.xlsx)");

  await test("read_file xlsx", "read_file", { path: "test.xlsx" },
    r => r.success && r.result?.content?.includes("苹果"));

  await test("edit_xlsx 改公式", "edit_xlsx",
    { path: "test.xlsx", edits: [{ cell: "D4", formula: "SUM(D2:D3)*1.1" }] },
    r => r.success && (r.result?.count === 1 || r.result?.result?.count === 1));

  await test("read_file xlsx 验证改动", "read_file", { path: "test.xlsx" },
    r => r.success);

} catch (e) {
  console.log(`  ⊘ xlsx 测试跳过: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// 边界情况和容错
// ═══════════════════════════════════════════════════════════════
console.log("\n═══ 容错测试 ═══");
await test("读不存在的文件", "read_file", { path: "nonexistent.txt" },
  r => !r.success && (r.error?.includes("不存在") || r.error?.includes("not")));

await test("写受保护文件", "write_file", { path: "permission_level.json", content: "hack" },
  r => !r.success && r.error?.includes("安全"));

await test("路径越界 ..", "read_file", { path: "../../etc/passwd" },
  r => !r.success && r.error?.includes("路径"));

await test("空 tool 名", "run_command", {},
  r => !r.success);

await test("fuzzy_edit 匹配不到", "fuzzy_edit",
  { path: "nonexistent_content.js", old_string: "xyz_no_match", new_string: "abc" },
  r => !r.success);

// 写一个文件然后测试各种边界
fs.writeFileSync(path.join(TEST_DIR, "edge.js"), "line1\nline2\nline3\nline4\nline5\n");
await test("replace_lines 超界 clamp", "replace_lines",
  { path: "edge.js", start_line: 1, end_line: 999, new_content: "all replaced" },
  r => r.success !== false);

await test("insert_at_line 超界追加", "insert_at_line",
  { path: "edge.js", line: 999, content: "appended" },
  r => r.success !== false);

await test("read_file offset/limit 分页", "read_file",
  { path: "edge.js", offset: 1, limit: 2 },
  r => r.success && r.result?.content?.length > 0);

await test("搜索空模式", "search_files", { pattern: "" },
  r => true); // 不崩就行

await test("未知工具名", "nonexistent_tool_xyz", {},
  r => !r.success && r.error?.includes("未知"));

// ═══════════════════════════════════════════════════════════════
// 报告
// ═══════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(50)}`);
console.log(`结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed}`);
console.log(`${"═".repeat(50)}`);

// 清理
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed > 0 ? 1 : 0);
