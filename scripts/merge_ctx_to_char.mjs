/**
 * _ctx（按对话切分）→ 角色卡级 合并脚本（20260726 凛倾定案：隔离只有用户级+角色卡级）
 *
 * 合并对象（每角色卡）：
 *   code_ctx/<chatid>/code_tables.json  → memory/code_tables.json
 *   work_ctx/<chatid>/work_tables.json  → memory/work_tables.json
 *   {code,work}_ctx/<chatid>/tasks.json → memory/tasks.json
 * 规则：
 *   · 行级去重：整行内容指纹（列值 join ），已存在则丢弃
 *   · 目录内行序保留；跨目录按该目录文件 mtime 升序拼接（旧在前，与 rows.push 尾插=index0 最旧同源）
 *   · 角色卡级已有行排在最前（它是既有基线）
 *   · 表结构（columns/name/rules/enabled）以角色卡级为准；角色卡级缺该表则取首个提供者的结构
 *   · rev 取各来源最大值 +1
 *   · 任务去重：按 id；同 id 取 mtime 较新的那份
 * 用法：node merge_ctx_to_char.mjs [--write]   不带 --write = dry-run 只报告
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");
const FP = (row) => (Array.isArray(row) ? row : [row]).map((v) => String(v ?? "")).join("");

function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch { return dflt; }
}

function mergeTablesForChar(memDir, mode) {
  const tablesFile = mode === "code" ? "code_tables.json" : "work_tables.json";
  const ctxRoot = path.join(memDir, `${mode}_ctx`);
  if (!fs.existsSync(ctxRoot)) return null;

  const basePath = path.join(memDir, tablesFile);
  const base = readJson(basePath, { tables: [] });
  const byId = new Map();
  for (const t of base.tables || []) {
    byId.set(t.id, { ...t, rows: [...(t.rows || [])] });
  }
  const seen = new Map(); // tableId -> Set(fp)
  for (const [id, t] of byId) seen.set(id, new Set((t.rows || []).map(FP)));

  // 各 ctx 目录按 mtime 升序（旧在前）
  const srcs = [];
  for (const d of fs.readdirSync(ctxRoot)) {
    const f = path.join(ctxRoot, d, tablesFile);
    if (!fs.existsSync(f)) continue;
    srcs.push({ chatid: d, file: f, mtime: fs.statSync(f).mtimeMs });
  }
  srcs.sort((a, b) => a.mtime - b.mtime);

  const report = { mode, sources: srcs.length, added: {}, dropped: {} };
  for (const s of srcs) {
    const j = readJson(s.file, { tables: [] });
    for (const t of j.tables || []) {
      if (!byId.has(t.id)) {
        byId.set(t.id, { ...t, rows: [] });
        seen.set(t.id, new Set());
      }
      const tgt = byId.get(t.id);
      const fps = seen.get(t.id);
      for (const r of t.rows || []) {
        const fp = FP(r);
        if (fps.has(fp)) { report.dropped[t.id] = (report.dropped[t.id] || 0) + 1; continue; }
        fps.add(fp);
        tgt.rows.push(r);
        report.added[t.id] = (report.added[t.id] || 0) + 1;
      }
      tgt.rev = Math.max(Number(tgt.rev || 0), Number(t.rev || 0));
    }
  }
  for (const t of byId.values()) t.rev = Number(t.rev || 0) + 1;

  const merged = { ...base, tables: [...byId.values()].sort((a, b) => a.id - b.id) };
  report.finalRows = Object.fromEntries(merged.tables.map((t) => [t.id, t.rows.length]));
  if (WRITE) {
    if (fs.existsSync(basePath)) fs.copyFileSync(basePath, `${basePath}.premerge`); // 卡级表文件可能不存在（从未切过该模式）
    fs.writeFileSync(basePath, JSON.stringify(merged, null, "\t") + "\n", "utf-8");
  }
  return report;
}

function mergeTasksForChar(memDir) {
  const basePath = path.join(memDir, "tasks.json");
  const base = readJson(basePath, []);
  const arr = Array.isArray(base) ? base : (base.tasks || []);
  const byId = new Map();
  for (const t of arr) byId.set(String(t.id ?? JSON.stringify(t)), { t, mtime: 0 });

  let srcCount = 0;
  for (const mode of ["code", "work"]) {
    const ctxRoot = path.join(memDir, `${mode}_ctx`);
    if (!fs.existsSync(ctxRoot)) continue;
    for (const d of fs.readdirSync(ctxRoot)) {
      const f = path.join(ctxRoot, d, "tasks.json");
      if (!fs.existsSync(f)) continue;
      srcCount++;
      const mtime = fs.statSync(f).mtimeMs;
      const j = readJson(f, []);
      const list = Array.isArray(j) ? j : (j.tasks || []);
      for (const t of list) {
        const key = String(t.id ?? JSON.stringify(t));
        const prev = byId.get(key);
        if (!prev || mtime > prev.mtime) byId.set(key, { t, mtime });
      }
    }
  }
  const merged = [...byId.values()].sort((a, b) => a.mtime - b.mtime).map((x) => x.t);
  if (WRITE) {
    if (fs.existsSync(basePath)) fs.copyFileSync(basePath, `${basePath}.premerge`);
    fs.writeFileSync(basePath, JSON.stringify(merged, null, "\t") + "\n", "utf-8");
  }
  return { sources: srcCount, total: merged.length };
}

const usersRoot = path.join(ROOT, "data", "users");
console.log(WRITE ? "=== 写入模式 ===" : "=== DRY-RUN（不写盘）===");
for (const u of fs.readdirSync(usersRoot)) {
  const charsRoot = path.join(usersRoot, u, "chars");
  if (!fs.existsSync(charsRoot)) continue;
  for (const c of fs.readdirSync(charsRoot)) {
    const memDir = path.join(charsRoot, c, "memory");
    if (!fs.existsSync(memDir)) continue;
    const hasCtx = ["code_ctx", "work_ctx"].some((d) => fs.existsSync(path.join(memDir, d)));
    if (!hasCtx) continue;
    console.log(`\n■ ${u} / ${c}`);
    for (const mode of ["code", "work"]) {
      const r = mergeTablesForChar(memDir, mode);
      if (!r) continue;
      const addTotal = Object.values(r.added).reduce((a, b) => a + b, 0);
      const dropTotal = Object.values(r.dropped).reduce((a, b) => a + b, 0);
      console.log(`  ${mode}: 来源 ${r.sources} 个对话目录 → 新增 ${addTotal} 行, 去重丢弃 ${dropTotal} 行`);
      console.log(`    最终各表行数: ${JSON.stringify(r.finalRows)}`);
    }
    const tk = mergeTasksForChar(memDir);
    console.log(`  tasks: 来源 ${tk.sources} 份 → 合并后 ${tk.total} 个任务`);
  }
}
console.log(WRITE ? "\n完成（原文件已存 .premerge 备份）" : "\nDRY-RUN 结束，未写任何文件。加 --write 执行。");
