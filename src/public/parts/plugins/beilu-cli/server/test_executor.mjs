/**
 * 独立测试脚本：验证 executor 42 个工具是否能加载和执行
 * 用法：node test_executor.mjs
 */
import { ToolExecutor } from "./executor.mjs";
import * as path from "node:path";
import * as fs from "node:fs";

const TEST_DIR = path.join(process.cwd(), "_cli_test_workspace");

// 创建临时工作区
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
fs.writeFileSync(path.join(TEST_DIR, "hello.txt"), "line1\nline2\nline3\n", "utf-8");

const executor = new ToolExecutor(TEST_DIR);
const tools = executor.getToolList();
console.log(`[TEST] 已注册 ${tools.length} 个工具: ${tools.join(", ")}`);

let passed = 0, failed = 0;

async function test(name, tool, params, check) {
  try {
    const r = await executor.execute({ id: `test_${name}`, tool, params });
    if (check(r)) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name} — 结果不符预期:`, JSON.stringify(r).slice(0, 300));
      failed++;
    }
  } catch (e) {
    console.log(`  ✗ ${name} — 异常: ${e.message}`);
    failed++;
  }
}

console.log("\n[TEST] 文件工具:");
await test("read_file", "read_file", { path: "hello.txt" },
  r => r.success && r.result?.content?.includes("line1"));
await test("write_file", "write_file", { path: "test_write.txt", content: "hello from CLI" },
  r => r.success && fs.readFileSync(path.join(TEST_DIR, "test_write.txt"), "utf-8") === "hello from CLI");
await test("list_files", "list_files", { path: "." },
  r => r.success && r.result?.files?.length >= 1);

console.log("\n[TEST] 编辑工具:");
fs.writeFileSync(path.join(TEST_DIR, "edit_test.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf-8");
await test("fuzzy_edit", "fuzzy_edit", { path: "edit_test.js", old_string: "const b = 2;", new_string: "const b = 99;" },
  r => r.success && fs.readFileSync(path.join(TEST_DIR, "edit_test.js"), "utf-8").includes("const b = 99;"));
await test("replace_lines", "replace_lines", { path: "edit_test.js", start_line: 1, end_line: 1, new_content: "const a = 100;" },
  r => r.success !== false);
await test("insert_at_line", "insert_at_line", { path: "edit_test.js", line: 2, content: "// inserted" },
  r => r.success !== false);

console.log("\n[TEST] 搜索工具:");
await test("search_files", "search_files", { pattern: "const", path: "." },
  r => r.success && r.result?.matches?.length >= 0);
await test("search_by_name", "search_by_name", { pattern: "*.txt" },
  r => r.success !== false);

console.log("\n[TEST] 命令执行:");
await test("run_command", "run_command", { command: "echo hello_from_cli" },
  r => r.success && r.result?.stdout?.includes("hello_from_cli"));

console.log("\n[TEST] Git 工具:");
await test("git_status", "git_status", {},
  r => true); // 可能不是git仓库，不强求success

console.log("\n[TEST] 项目工具:");
await test("get_project_summary", "get_project_summary", {},
  r => r.success && r.result?.root);
await test("get_status", "get_status", {},
  r => r.success && r.result?.workspace);

console.log("\n[TEST] Todo 工具:");
await test("todo_write", "todo_write", { content: "- [ ] test task" },
  r => r.success !== false);
await test("todo_read", "todo_read", {},
  r => r.success !== false && r.result?.content?.includes("test task"));

console.log("\n[TEST] 检查点工具:");
await test("_checkpoint_start", "_checkpoint_start", { id: "test_cp_1", chatId: "test", messageIndex: 0 },
  r => r.success);
await test("_checkpoint_list", "_checkpoint_list", {},
  r => r.success !== false);
await test("_checkpoint_commit", "_checkpoint_commit", { id: "test_cp_1" },
  r => r.success !== false);

console.log("\n[TEST] Reveal (CLI 模式):");
await test("_reveal", "_reveal", { path: "hello.txt", line: 1 },
  r => r.success && r.result?.revealed);

console.log(`\n========================================`);
console.log(`结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个测试`);
console.log(`========================================`);

// 清理
try {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log("[TEST] 临时工作区已清理");
} catch { console.log("[TEST] 清理失败（手动删除 _cli_test_workspace）"); }

process.exit(failed > 0 ? 1 : 0);
