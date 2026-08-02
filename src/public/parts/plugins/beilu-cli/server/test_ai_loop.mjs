/**
 * AI 实测脚本：Gemini 3.5 Flash → ideToolCall → CLI executor → 结果回注 → AI 续轮
 * 独立运行，不依赖本体。
 */
import { ToolExecutor } from "./executor.mjs";
import https from "node:https";
import http from "node:http";

// 测试用 AI 源经环境变量注入（禁硬编码真实网关/密钥进仓库）
const API_URL = process.env.BEILU_TEST_API_URL || "https://api.example.com/v1/chat/completions";
const API_KEY = process.env.BEILU_TEST_API_KEY || "";
const MODEL = "gemini-2.5-flash";

// 工作区 = 当前目录
const WORKSPACE = process.cwd();
const executor = new ToolExecutor(WORKSPACE);
console.log(`[AI-TEST] 工作区: ${WORKSPACE}`);
console.log(`[AI-TEST] 已注册 ${executor.getToolList().length} 个工具\n`);

// ideToolCall 标签解析（从 ideTagParser.mjs 简化移植）
function parseIdeToolCalls(text) {
  const calls = [];
  // 自闭合: <ideToolCall tool="xxx" param1="val1" />
  const selfRe = /<ideToolCall\s+([^>]*?)\/>/g;
  let m;
  while ((m = selfRe.exec(text)) !== null) {
    const attrs = m[1];
    const tool = attrs.match(/tool="([^"]+)"/)?.[1];
    if (!tool) continue;
    const params = {};
    for (const am of attrs.matchAll(/(\w+)="([^"]*)"/g)) {
      if (am[1] !== "tool") params[am[1]] = am[2];
    }
    calls.push({ tool, params });
  }
  // 配对标签: <ideToolCall tool="xxx">JSON</ideToolCall>
  const pairRe = /<ideToolCall\s+tool="([^"]+)"[^>]*>([\s\S]*?)<\/ideToolCall>/g;
  while ((m = pairRe.exec(text)) !== null) {
    const tool = m[1];
    try {
      const params = JSON.parse(m[2].trim());
      calls.push({ tool, params });
    } catch {
      calls.push({ tool, params: { content: m[2].trim() } });
    }
  }
  return calls;
}

// 调 API
function callAPI(messages) {
  const body = JSON.stringify({ model: MODEL, messages, max_tokens: 2048 });
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        "User-Agent": "beilu-cli/1.0",
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message || JSON.stringify(json.error)));
          else resolve(json.choices?.[0]?.message?.content || "");
        } catch (e) { reject(new Error(`API 响应解析失败: ${data.slice(0, 300)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("API 超时")); });
    req.write(body);
    req.end();
  });
}

// 格式化工具结果
function formatResults(results) {
  let text = "[IDE工具执行结果]\n";
  for (const r of results) {
    text += `--- ${r.tool} ---\n`;
    if (r.result.success !== false) {
      const inner = r.result.result;
      text += typeof inner === "string" ? inner.slice(0, 2000) : JSON.stringify(inner, null, 2).slice(0, 2000);
    } else {
      text += `❌ 失败: ${r.result.error || "未知错误"}`;
    }
    text += "\n";
  }
  text += "[/IDE工具执行结果]";
  return text;
}

// 主循环
async function main() {
  const systemPrompt = `你是一个编程助手。你可以使用以下 IDE 工具来操作用户的文件系统：

可用工具（通过 <ideToolCall> 标签调用）：
- read_file: 读取文件。用法: <ideToolCall tool="read_file" path="文件路径" />
- write_file: 写入文件。用法: <ideToolCall tool="write_file" path="文件路径">文件内容</ideToolCall>
- list_files: 列出目录。用法: <ideToolCall tool="list_files" path="目录路径" />
- search_files: 搜索文件内容。用法: <ideToolCall tool="search_files" pattern="搜索模式" path="搜索目录" />
- run_command: 执行命令。用法: <ideToolCall tool="run_command" command="命令" />
- git_status: 查看 git 状态。用法: <ideToolCall tool="git_status" />
- get_project_summary: 项目概要。用法: <ideToolCall tool="get_project_summary" />
- fuzzy_edit: 模糊编辑。用法: <ideToolCall tool="fuzzy_edit" path="路径" old_string="旧内容" new_string="新内容" />

工具结果会在下一轮消息中返回。请直接使用工具完成用户的请求。`;

  const userPrompt = "请先用 list_files 看看当前目录有什么文件，然后用 read_file 读取 package.json 的内容，最后用 run_command 执行 node --version 看看 Node.js 版本。";

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const MAX_ROUNDS = 5;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`[轮次 ${round}] 调用 Gemini API...`);

    let aiReply;
    try {
      aiReply = await callAPI(messages);
    } catch (e) {
      console.error(`[API 错误] ${e.message}`);
      break;
    }

    console.log(`[AI 回复] ${aiReply.slice(0, 500)}${aiReply.length > 500 ? "..." : ""}`);

    // 解析工具调用
    const toolCalls = parseIdeToolCalls(aiReply);
    if (toolCalls.length === 0) {
      console.log("\n[完成] AI 没有调用工具，对话结束。");
      break;
    }

    console.log(`\n[解析到 ${toolCalls.length} 个工具调用]`);

    // 执行工具
    const results = [];
    for (const tc of toolCalls) {
      console.log(`  → 执行 ${tc.tool}(${JSON.stringify(tc.params).slice(0, 100)})`);
      const result = await executor.execute({ id: `test_${round}_${tc.tool}`, tool: tc.tool, params: tc.params });
      console.log(`  ← ${result.success ? "✓" : "✗"} ${JSON.stringify(result.result || result.error).slice(0, 150)}`);
      results.push({ tool: tc.tool, result });
    }

    // 注入结果到对话
    const resultText = formatResults(results);
    messages.push({ role: "assistant", content: aiReply });
    messages.push({ role: "user", content: resultText });
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("[AI 实测完成]");
}

main().catch(e => { console.error(`[致命错误] ${e.message}`); process.exit(1); });
