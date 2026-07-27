/**
 * check_import_cycles.mjs — ESM 静态 import 环 / TDZ 爆点守卫（0722 事故催生的硬信号）
 *
 * 【为什么存在】0722 事故：storage.mjs 新增一条 import 边成环，环内 commandGate 顶层立即调用
 *   storage 导出 → `__projectRoot` TDZ ReferenceError → 全部插件 load_failed。环安全是全图传递
 *   性质，靠注释承诺（"已核实无环"）必然腐烂——本脚本把约定变成机器强制。
 *
 * 【三重检查】
 *   1. 新增环：src 下静态 import 图的 SCC（>1 成员）必须都在基线内（基线=历史遗留环，只减不增）。
 *   2. 环内顶层调用：环成员在模块顶层（列 0 语句）调用同环成员的导出 = TDZ 直接爆点，恒零容忍。
 *   3. 叶子不变量：storage.mjs 不得传递可达 injectionSystem/ideClient/commandGate
 *      （这三处历史上顶层消费 storage 导出，storage 再回边即复爆 0722）。
 *
 * 【用法】
 *   node tests/check_import_cycles.mjs              # 校验，违规 exit 1
 *   node tests/check_import_cycles.mjs --update-baseline  # 环基线重写（仅在有意消除旧环后用）
 *   基线文件：tests/import_cycles_baseline.json
 *
 * 【局限】顶层调用检测是列 0 启发（本仓库格式统一顶层不缩进）；多行顶层 IIFE/if 块内的立即调用
 *   抓不到，属人工审查域。动态 import() 不参与静态求值序，不计入环。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "src");
const BASELINE_PATH = path.join(__dirname, "import_cycles_baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

// 叶子不变量：from 不得传递可达 targets（相对 src 的 / 路径）
const LEAF_INVARIANTS = [
  {
    from: "yonban/core/functions/memory/storage_mod/storage.mjs",
    forbidden: [
      "yonban/core/functions/memory/storage_mod/injectionSystem.mjs",
      "yonban/core/transport/ideClient.mjs",
      "yonban/core/functions/security/commandGate.mjs",
    ],
    why: "0722 TDZ 事故：三目标历史上顶层消费 storage 导出，storage 回边即全插件崩",
  },
];

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".mjs")) files.push(p);
  }
})(ROOT);
const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");

const STATIC_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;
function resolveSpec(fromFile, spec) {
  if (!spec || !spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + ".mjs", path.join(base, "index.mjs")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
function parseImportedBindings(src) {
  const out = new Map();
  const re = /(?:^|\n)[ \t]*import\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1], from = m[2];
    const star = clause.match(/\*\s*as\s+([\w$]+)/);
    if (star) out.set(star[1], from);
    const def = clause.match(/^\s*([\w$]+)\s*(?:,|$)/);
    if (def) out.set(def[1], from);
    const named = clause.match(/\{([^}]*)\}/);
    if (named) for (const part of named[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      const as = p.match(/^[\w$]+\s+as\s+([\w$]+)$/);
      out.set(as ? as[1] : p.split(/\s+/)[0], from);
    }
  }
  return out;
}
function findTopLevelCalls(src, importedBindings) {
  const out = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!/^(?:export\s+)?(?:const|let|var)\s|^[A-Za-z_$][\w$.]*\s*\(/.test(L)) continue;
    if (/^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\b|function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(L)) continue;
    if (/^(?:export\s+)?(?:async\s+)?function\b|^class\b|^export\s+(?:default\s+)?(?:async\s+)?function\b|^export\s+class\b/.test(L)) continue;
    for (const cm of L.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const callee = cm[1];
      if (["if", "for", "while", "switch", "catch", "function", "return"].includes(callee)) continue;
      if (importedBindings.has(callee)) out.push({ line: i + 1, callee, from: importedBindings.get(callee), text: L.trim().slice(0, 160) });
    }
  }
  return out;
}

const graph = new Map(), meta = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const r = rel(f);
  const edges = new Set();
  for (const re of [STATIC_IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const t = resolveSpec(f, m[1]);
      if (t) edges.add(rel(t));
    }
  }
  const importedBindings = parseImportedBindings(src);
  graph.set(r, edges);
  meta.set(r, { importedBindings, topLevelCalls: findTopLevelCalls(src, importedBindings) });
}

// Tarjan SCC
let idx = 0;
const st = [], onSt = new Set(), low = new Map(), num = new Map(), sccs = [];
function strongconnect(v) {
  num.set(v, idx); low.set(v, idx); idx++;
  st.push(v); onSt.add(v);
  for (const w of graph.get(v) || []) {
    if (!graph.has(w)) continue;
    if (!num.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onSt.has(w)) low.set(v, Math.min(low.get(v), num.get(w)));
  }
  if (low.get(v) === num.get(v)) {
    const scc = [];
    let w;
    do { w = st.pop(); onSt.delete(w); scc.push(w); } while (w !== v);
    if (scc.length > 1) sccs.push(scc);
  }
}
for (const v of graph.keys()) if (!num.has(v)) strongconnect(v);

const canon = (members) => [...members].sort().join(" | ");
const currentKeys = sccs.map((s) => canon(s));

if (UPDATE) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), cycles: sccs.map((s) => [...s].sort()) }, null, 2) + "\n");
  console.log(`baseline 已重写：${sccs.length} 环 → ${BASELINE_PATH}`);
  process.exit(0);
}

let baseline = { cycles: [] };
try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")); } catch {
  console.error(`基线文件缺失/损坏：${BASELINE_PATH}（先跑 --update-baseline 生成）`);
  process.exit(1);
}
const baselineKeys = new Set(baseline.cycles.map((c) => canon(c)));

let failed = false;

// 检查 1：新增环
for (let i = 0; i < sccs.length; i++) {
  if (!baselineKeys.has(currentKeys[i])) {
    failed = true;
    console.error(`\n[FAIL] 新增 import 环（${sccs[i].length} 成员，不在基线）：`);
    for (const m of sccs[i]) console.error(`    ${m}`);
    console.error(`  → 拆环（依赖下沉叶子/接口反转），不要把它加进基线。`);
  }
}
const gone = [...baselineKeys].filter((k) => !currentKeys.includes(k));
if (gone.length) console.log(`[INFO] ${gone.length} 个基线环已消除，可跑 --update-baseline 收缩基线。`);

// 检查 2：环内顶层调用（TDZ 直接爆点，零容忍）
for (const scc of sccs) {
  const set = new Set(scc);
  for (const m of scc) {
    for (const c of meta.get(m).topLevelCalls) {
      const t = resolveSpec(path.join(ROOT, m), c.from);
      if (t && set.has(rel(t))) {
        failed = true;
        console.error(`\n[FAIL] 环内顶层调用（TDZ 爆点）：${m}:${c.line} 顶层调 ${c.callee}() ← 同环成员 ${rel(t)}`);
        console.error(`    ${c.text}\n  → 改函数内取值/惰性初始化（endpoints.mjs 函数内取值范式）。`);
      }
    }
  }
}

// 检查 3：叶子不变量（BFS 可达性）
for (const inv of LEAF_INVARIANTS) {
  const seen = new Set([inv.from]);
  const q = [inv.from];
  while (q.length) {
    const cur = q.shift();
    for (const nxt of graph.get(cur) || []) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      q.push(nxt);
    }
  }
  for (const f of inv.forbidden) {
    if (seen.has(f)) {
      failed = true;
      console.error(`\n[FAIL] 叶子不变量破坏：${inv.from} 传递可达 ${f}`);
      console.error(`  why: ${inv.why}`);
    }
  }
}

if (failed) {
  console.error(`\n扫描 ${files.length} 文件：存在违规（见上）。`);
  process.exit(1);
}
console.log(`OK：扫描 ${files.length} 文件，${sccs.length} 环全在基线内，环内顶层调用 0，叶子不变量成立。`);
