/**
 * check-syntax.mjs — YonBan 全库非法语法检查（零外部依赖，typescript 用仓库自带 devDep）
 *
 * 检查三层（每层针对一类真实翻车模式）：
 *   1. 控制字符扫描 — bash 双层转义/heredoc 会把 \1 反引用变成 \x01 等控制字符写进文件，
 *      Read 显示正常但编译/运行时炸（历史真实事故模式）。扫 src + webview-ui 全部文本文件。
 *   2. webview-ui/*.js — node --check 逐文件语法校验（webview 原样加载源文件，无编译兜底）。
 *   3. src 下全部 .ts — typescript transpileModule 语法诊断（esbuild 构建不做完整语法报告，
 *      transpile 层能抓非法 token/残缺注释这类"非法语法"，不做类型检查=快）。
 *
 * 用法：node scripts/check-syntax.mjs   （在 YonBan 仓库根运行；npm run check-syntax）
 * 退出码：0=全部干净，1=有发现（发现逐条打印 file:line:col + 原因）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const SCAN_DIRS = ["src", "webview-ui"];
const TEXT_EXTS = new Set([".ts", ".js", ".mjs", ".css", ".json", ".html"]);
let findings = 0;

function report(file, line, col, msg) {
  findings++;
  console.error(`  ✗ ${relative(ROOT, file)}:${line}:${col} — ${msg}`);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ── 1. 控制字符（\x00-\x08 \x0B \x0C \x0E-\x1F，容许 \t \n \r） ──
console.log("[1/3] 控制字符扫描 (src + webview-ui 全部文本文件)");
const files = SCAN_DIRS.flatMap((d) => [...walk(join(ROOT, d))]).filter((f) =>
  TEXT_EXTS.has(extname(f)),
);
const CTRL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CTRL);
    if (m) report(f, i + 1, m.index + 1, `控制字符 \\x${m[0].charCodeAt(0).toString(16).padStart(2, "0")}（疑似转义事故写入）`);
  }
}

// ── 2. webview-ui JS：node --check ──
console.log("[2/3] node --check (webview-ui/*.js，原样加载无编译兜底)");
for (const f of files.filter((f) => f.includes("webview-ui") && /\.(js|mjs)$/.test(f))) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    const msg = String(e.stderr || e.message).split("\n").slice(0, 3).join(" | ");
    report(f, 0, 0, `node --check 失败: ${msg}`);
  }
}

// ── 3. src TS：transpileModule 语法诊断（不做类型检查，只抓非法语法） ──
console.log("[3/3] TypeScript 语法诊断 (src 下全部 .ts)");
for (const f of files.filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(f, "utf8");
  // createSourceFile 纯解析（不 transpile 不查类型）：parseDiagnostics 即语法错误列表。
  // 不用 transpileModule——它对个别文件抛 "Output generation failed"（emit 层崩溃，与语法无关）。
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, /*setParentNodes*/ false);
  for (const d of sf.parseDiagnostics ?? []) {
    const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    report(f, pos.line + 1, pos.character + 1, ts.flattenDiagnosticMessageText(d.messageText, " "));
  }
}

if (findings === 0) {
  console.log(`✓ 干净：${files.length} 个文件，0 发现`);
} else {
  console.error(`✗ 共 ${findings} 处发现`);
  process.exit(1);
}
