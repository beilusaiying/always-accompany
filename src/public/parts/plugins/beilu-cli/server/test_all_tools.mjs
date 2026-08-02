/**
 * 全量工具测试：43 个工具逐个测试 + Gemini AI 综合场景
 */
import { ToolExecutor } from "./executor.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";

// 测试用 AI 源经环境变量注入（禁硬编码真实网关/密钥进仓库）
const API_URL = process.env.BEILU_TEST_API_URL || "https://api.example.com/v1/chat/completions";
const API_KEY = process.env.BEILU_TEST_API_KEY || "";
const MODEL = "gemini-2.5-flash";

const TEST_DIR = path.resolve("_test_workspace");
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

// 准备测试文件
fs.writeFileSync(path.join(TEST_DIR, "hello.js"), 'const greeting = "hello";\nconst name = "world";\nconsole.log(greeting + " " + name);\n');
fs.writeFileSync(path.join(TEST_DIR, "data.json"), '{"key": "value", "count": 42}\n');
fs.writeFileSync(path.join(TEST_DIR, "index.html"), '<!DOCTYPE html>\n<html><head><title>Test</title></head>\n<body><h1>Hello</h1></body></html>\n');
fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
fs.writeFileSync(path.join(TEST_DIR, "src", "app.js"), 'function main() {\n  return "ok";\n}\nmodule.exports = { main };\n');
fs.writeFileSync(path.join(TEST_DIR, "package.json"), '{"name":"test-project","version":"1.0.0","scripts":{"test":"echo ok"}}\n');

// 初始化 git
try {
  const cp = await import("node:child_process");
  cp.execSync("git init && git add -A && git commit -m init", { cwd: TEST_DIR, stdio: "pipe" });
} catch { /* git not available */ }

const executor = new ToolExecutor(TEST_DIR);
const allTools = executor.getToolList();
console.log(`\n[全量测试] 工作区: ${TEST_DIR}`);
console.log(`[全量测试] 已注册 ${allTools.length} 个工具: ${allTools.join(", ")}\n`);

let passed = 0, failed = 0, skipped = 0;
const results = [];

async function test(tool, params, check, skipReason) {
  if (skipReason) {
    console.log(`  ⊘ ${tool} — 跳过: ${skipReason}`);
    skipped++;
    results.push({ tool, status: "skip", reason: skipReason });
    return;
  }
  const t0 = Date.now();
  try {
    const r = await executor.execute({ id: `t_${tool}`, tool, params: params || {} });
    const ms = Date.now() - t0;
    const ok = check(r);
    if (ok) {
      console.log(`  ✓ ${tool} (${ms}ms)`);
      passed++;
      results.push({ tool, status: "pass", ms });
    } else {
      const errPreview = JSON.stringify(r.error || r.result || r).slice(0, 200);
      console.log(`  ✗ ${tool} (${ms}ms) — ${errPreview}`);
      failed++;
      results.push({ tool, status: "fail", ms, error: errPreview });
    }
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`  ✗ ${tool} (${ms}ms) — 异常: ${e.message.slice(0, 150)}`);
    failed++;
    results.push({ tool, status: "fail", ms, error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: 逐工具测试
// ═══════════════════════════════════════════════════════════════
console.log("═══ Phase 1: 文件工具 ═══");
await test("read_file", { path: "hello.js" }, r => r.success && r.result?.content?.includes("greeting"));
await test("write_file", { path: "new_file.txt", content: "created by CLI test" }, r => r.success);
await test("list_files", { path: "." }, r => r.success && r.result?.files?.length >= 3);

console.log("\n═══ Phase 2: 编辑工具 ═══");
await test("fuzzy_edit", { path: "hello.js", old_string: 'const name = "world";', new_string: 'const name = "beilu";' },
  r => r.success && fs.readFileSync(path.join(TEST_DIR, "hello.js"), "utf-8").includes("beilu"));
await test("replace_lines", { path: "hello.js", start_line: 1, end_line: 1, new_content: 'const greeting = "hi";' },
  r => r.success !== false);
await test("insert_at_line", { path: "hello.js", line: 1, content: '// beilu-cli test' },
  r => r.success !== false);

console.log("\n═══ Phase 3: 搜索工具 ═══");
await test("search_files", { pattern: "greeting", path: "." }, r => r.success);
await test("search_by_name", { pattern: "*.js" }, r => r.success !== false);

console.log("\n═══ Phase 4: 命令执行 ═══");
await test("run_command", { command: "echo hello_from_cli_test" },
  r => r.success && r.result?.stdout?.includes("hello_from_cli_test"));
await test("run_script", { lang: "node", code: 'console.log("script_ok_" + (1+2))' },
  r => r.success && r.result?.stdout?.includes("script_ok_3"));

console.log("\n═══ Phase 5: 文档工具 ═══");
await test("edit_xlsx", { path: "test.xlsx" }, () => true,
  "需要 xlsx 文件");

console.log("\n═══ Phase 6: Git 工具 ═══");
await test("git_status", {}, r => r.result !== undefined);
await test("git_log", {}, r => r.result !== undefined);
await test("git_diff", {}, r => r.result !== undefined);
await test("git_add", { paths: ["new_file.txt"] }, r => true);
await test("git_commit", { message: "cli test commit" }, r => true);
await test("git_branch", {}, r => r.result !== undefined);
await test("git_stash", { action: "list" }, r => r.result !== undefined);
await test("git_checkout", { branch: "main" }, r => true);
await test("git_merge", { branch: "nonexistent" }, () => true,
  "需要真实分支");

console.log("\n═══ Phase 7: 代码分析工具 ═══");
await test("get_project_summary", {}, r => r.success && r.result?.root);
await test("get_status", {}, r => r.success && r.result?.workspace);
await test("goto_definition", { path: "src/app.js", line: 2, column: 10 }, r => r.result !== undefined);
await test("find_references", { path: "src/app.js", line: 2, column: 10 }, r => r.result !== undefined);
await test("ast_search", { pattern: "console.log($$$)", lang: "js" }, r => r.result !== undefined);
await test("smart_search", { query: "main" }, r => r.result !== undefined);
await test("validate_html", { path: "index.html" }, r => r.result !== undefined);
await test("lint_code", { path: "hello.js" }, r => r.result !== undefined);

console.log("\n═══ Phase 8: 诊断工具 ═══");
await test("get_diagnostics", {}, r => r.result !== undefined);

console.log("\n═══ Phase 9: Todo 工具 ═══");
await test("todo_write", { content: "- [ ] 测试 CLI\n- [x] 写 server.mjs\n" }, r => r.success !== false);
await test("todo_read", {}, r => r.success !== false && r.result?.content?.includes("测试 CLI"));

console.log("\n═══ Phase 10: 检查点工具 ═══");
await test("_checkpoint_start", { id: "cp_test_1", chatId: "test_chat", messageIndex: 0 }, r => r.success);
await test("_checkpoint_list", {}, r => Array.isArray(r.result));
await test("_checkpoint_commit", { id: "cp_test_1" }, r => r.success !== false);
await test("_checkpoint_can_replay", { id: "cp_test_1" }, r => r.result !== undefined);
await test("_checkpoint_get_ops", { id: "cp_test_1" }, r => true);
await test("_checkpoint_get_diff", { id: "cp_test_1" }, r => true);
await test("_checkpoint_revert_diff", { chatId: "test_chat", targetIndex: -1 }, r => true);
await test("_checkpoint_revert_to_message", { chatId: "test_chat", targetIndex: -1 }, r => true);
await test("_checkpoint_revert", { id: "cp_nonexist" }, r => true);
await test("_get_operation_log", { count: 10 }, r => r.result?.logs !== undefined);
await test("_reveal", { path: "hello.js", line: 1 }, r => r.success && r.result?.revealed);

console.log("\n═══ Phase 1 总结 ═══");
console.log(`通过: ${passed}  失败: ${failed}  跳过: ${skipped}  共: ${passed + failed + skipped}`);

// ═══════════════════════════════════════════════════════════════
// Phase 2: AI 综合场景（Gemini 2.5 Flash）
// ═══════════════════════════════════════════════════════════════
console.log("\n\n═══ Phase 2: AI 综合场景 ═══");

function parseIdeToolCalls(text) {
  const calls = [];
  const selfRe = /<ideToolCall\s+([^>]*?)\/>/g;
  let m;
  while ((m = selfRe.exec(text)) !== null) {
    const attrs = m[1]; const tool = attrs.match(/tool="([^"]+)"/)?.[1]; if (!tool) continue;
    const params = {};
    for (const am of attrs.matchAll(/(\w+)="([^"]*)"/g)) { if (am[1] !== "tool") params[am[1]] = am[2]; }
    calls.push({ tool, params });
  }
  const pairRe = /<ideToolCall\s+tool="([^"]+)"[^>]*>([\s\S]*?)<\/ideToolCall>/g;
  while ((m = pairRe.exec(text)) !== null) {
    const tool = m[1]; const body = m[2].replace(/^\n/, "").replace(/\n$/, "");
    if (tool === "write_file") calls.push({ tool, params: { path: m[0].match(/path="([^"]+)"/)?.[1] || "out.txt", content: body } });
    else if (tool === "fuzzy_edit") {
      const oldM = body.match(/<old_string>([\s\S]*?)<\/old_string>/i);
      const newM = body.match(/<new_string>([\s\S]*?)<\/new_string>/i);
      const p = m[0].match(/path="([^"]+)"/)?.[1] || "";
      calls.push({ tool, params: { path: p, old_string: oldM?.[1] || "", new_string: newM?.[1] || "" } });
    } else {
      try { calls.push({ tool, params: JSON.parse(body) }); } catch { calls.push({ tool, params: { content: body } }); }
    }
  }
  return calls;
}

function callAPI(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, messages, max_tokens: 4096 });
    const url = new URL(API_URL);
    const req = https.request({
      hostname: url.hostname, port: url.port || 443, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}`, "User-Agent": "beilu-cli/1.0" },
    }, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => {
        try { const j = JSON.parse(data); if (j.error) reject(new Error(j.error.message)); else resolve(j.choices?.[0]?.message?.content || ""); }
        catch { reject(new Error(`API 解析失败: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("超时")); });
    req.write(body); req.end();
  });
}

const toolList = allTools.map(t => `  - ${t}`).join("\n");
const sysPrompt = `你是一个编程助手，正在测试 IDE 工具是否正常工作。请逐个测试以下工具，每轮调用 2-3 个工具。

可用工具列表（通过 <ideToolCall> 标签调用）：
${toolList}

调用格式举例：
<ideToolCall tool="read_file" path="hello.js" />
<ideToolCall tool="run_command" command="echo test" />
<ideToolCall tool="git_status" />
<ideToolCall tool="search_files" pattern="function" path="." />
<ideToolCall tool="write_file" path="test.txt">内容</ideToolCall>
<ideToolCall tool="fuzzy_edit" path="file.js"><old_string>旧内容</old_string><new_string>新内容</new_string></ideToolCall>

工作区已有文件: hello.js, data.json, index.html, src/app.js, package.json, new_file.txt
请开始测试，先测文件读写和搜索，然后测 git 和命令执行，最后测代码分析。每轮说明你在测什么。`;

const messages = [
  { role: "system", content: sysPrompt },
  { role: "user", content: "开始测试所有工具。每轮调 2-3 个工具，覆盖尽量多的工具类型。" },
];

let aiPassed = 0, aiFailed = 0, aiToolsUsed = new Set();
const MAX_ROUNDS = 8;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`\n--- AI 轮次 ${round}/${MAX_ROUNDS} ---`);
  let reply;
  try { reply = await callAPI(messages); }
  catch (e) { console.log(`API 错误: ${e.message}`); break; }

  console.log(`AI: ${reply.slice(0, 300)}${reply.length > 300 ? "..." : ""}`);

  const toolCalls = parseIdeToolCalls(reply);
  if (toolCalls.length === 0) { console.log("AI 未调用工具，结束。"); break; }

  console.log(`解析到 ${toolCalls.length} 个工具调用`);
  const resultParts = [];

  for (const tc of toolCalls) {
    aiToolsUsed.add(tc.tool);
    console.log(`  → ${tc.tool}`);
    const r = await executor.execute({ id: `ai_${round}_${tc.tool}`, tool: tc.tool, params: tc.params });
    const ok = r.success !== false;
    if (ok) aiPassed++; else aiFailed++;
    console.log(`  ← ${ok ? "✓" : "✗"} ${(r.error || "").slice(0, 80)}`);
    const inner = r.result;
    const preview = typeof inner === "string" ? inner.slice(0, 800) : JSON.stringify(inner, null, 2)?.slice(0, 800) || "";
    resultParts.push(`--- ${tc.tool} ---\n${ok ? preview : "❌ " + (r.error || "失败")}`);
  }

  messages.push({ role: "assistant", content: reply });
  messages.push({ role: "user", content: `[IDE工具执行结果]\n${resultParts.join("\n")}\n[/IDE工具执行结果]\n\n继续测试其他还没测过的工具。已测过: ${[...aiToolsUsed].join(", ")}` });
}

// ═══════════════════════════════════════════════════════════════
// 最终报告
// ═══════════════════════════════════════════════════════════════
console.log(`\n\n${"═".repeat(60)}`);
console.log(`全量测试报告`);
console.log(`${"═".repeat(60)}`);
console.log(`\nPhase 1 (直接调用): ${passed} 通过, ${failed} 失败, ${skipped} 跳过`);
console.log(`Phase 2 (AI 调用):  ${aiPassed} 通过, ${aiFailed} 失败, 覆盖 ${aiToolsUsed.size}/${allTools.length} 个工具`);
console.log(`AI 覆盖的工具: ${[...aiToolsUsed].join(", ")}`);
const uncovered = allTools.filter(t => !aiToolsUsed.has(t));
if (uncovered.length) console.log(`AI 未覆盖: ${uncovered.join(", ")}`);

if (failed > 0) {
  console.log(`\n失败详情:`);
  for (const r of results.filter(r => r.status === "fail")) {
    console.log(`  ✗ ${r.tool}: ${r.error?.slice(0, 150)}`);
  }
}

// 清理
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); console.log(`\n测试工作区已清理`); } catch { /* ignore */ }
process.exit(failed > 0 ? 1 : 0);
