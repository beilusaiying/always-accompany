// check-release.mjs — 发布前监测：机密件残留 + 敏感信息硬扫
//
// why: 0716/0719 两次发布筛查都是人工硬扫 + 临时派分身（同步记录3月17号之后.md），
//      清单记在 MD 里、靠人记得跑。改成可重跑脚本：规则与 build-release 同源，
//      推送前跑一次，非 0 退出码即拦。
// 功能链: release-manifest.json → _manifest-lib.mjs → [本脚本] → 命中报告 + exit code
//          （生产端 build-release.mjs 负责剔除，本脚本负责证明剔干净了）
//
// 用法:
//   node scripts/release/check-release.mjs --target=<发布物根目录> [--profile=public|exe|full] [--json]
//   exit 0 = 干净；exit 1 = 有命中；exit 2 = 参数/环境错误
//
// 说明: 只扫文本类扩展名且 < maxKB 的文件；被跳过的一律计数并在末尾列出，
//       不做"静默截断"（漏扫却报干净比不扫更危险）。

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { loadManifest, compileExcludes, matchExclude, hasKeepUnder, compileScanRules, isAllowedFor } from "./_manifest-lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const TARGET = args.target;
const PROFILE = args.profile || "public";
const MAX_KB = Number(args.maxKB || 2048);
if (!TARGET) { console.error("需要 --target=<发布物根目录>"); process.exit(2); }
if (!existsSync(TARGET)) { console.error(`--target 不存在: ${TARGET}`); process.exit(2); }

const TEXT_EXT = new Set([
  ".mjs", ".js", ".cjs", ".ts", ".mts", ".tsx", ".jsx", ".json", ".jsonc",
  ".md", ".txt", ".html", ".htm", ".css", ".scss", ".yml", ".yaml",
  ".sh", ".bat", ".ps1", ".py", ".toml", ".ini", ".cfg", ".env", ".xml", ".svg",
]);
const manifest = loadManifest(args.manifest);
const scanRules = compileScanRules(manifest);
// 残留检查只看机密组：运行时产物（node_modules 等）在 exe 包里是合法存在的
const confidentialRules = compileExcludes(
  { confidential: manifest.confidential },
  { skipGroups: PROFILE === "full" ? ["confidential"] : [] }
);
// 硬扫跳过范围 = manifest 全部 exclude（单源）。任何"不会进发布物"的目录都不该产生命中：
// 0727 实测直接扫本体时 data/ 用户数据独自贡献 361 处噪音，把真信号淹没。
// 用 manifest 而非脚本里硬编码目录名，才不会与 build-release 的判断分叉。
const scanSkipRules = compileExcludes(manifest, {});

const findings = { residue: [], scan: [] };
const counters = { files: 0, scanned: 0, skippedBig: 0, skippedBinary: 0, skippedDirs: 0 };
const skippedBigList = [];

function walk(root, base = root) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = join(root, e.name);
    const rel = relative(base, abs).replace(/\\/g, "/");

    if (e.isDirectory()) {
      // 机密目录整个残留 → 记一条，不逐文件刷屏。
      // 但目录内埋着 keep 例外时必须下钻，否则会把合法保留件（nlp/tokenizer.mjs）误报成残留。
      const hit = matchExclude(confidentialRules, rel);
      if (hit && !hasKeepUnder(confidentialRules, rel)) {
        findings.residue.push({ path: rel, rule: hit.rule, group: hit.group, isDir: true });
        continue;
      }
      // 不会进发布物的目录不参与硬扫（同样要让开埋在里面的 keep 例外）
      if (matchExclude(scanSkipRules, rel) && !hasKeepUnder(scanSkipRules, rel)) { counters.skippedDirs++; continue; }
      walk(abs, base);
      continue;
    }

    counters.files++;
    const hit = matchExclude(confidentialRules, rel);
    if (hit) { findings.residue.push({ path: rel, rule: hit.rule, group: hit.group, isDir: false }); continue; }
    if (matchExclude(scanSkipRules, rel)) { counters.skippedDirs++; continue; }

    if (!TEXT_EXT.has(extname(e.name).toLowerCase())) { counters.skippedBinary++; continue; }
    let sz = 0;
    try { sz = statSync(abs).size; } catch { continue; }
    if (sz / 1024 > MAX_KB) { counters.skippedBig++; skippedBigList.push(`${rel} (${(sz / 1024 / 1024).toFixed(1)}MB)`); continue; }

    let text;
    try { text = readFileSync(abs, "utf8"); } catch { counters.skippedBinary++; continue; }
    counters.scanned++;

    for (const r of scanRules) {
      if (isAllowedFor(r, rel)) continue;
      r.re.lastIndex = 0;
      // 报全部命中，不是只报第一处：只报第一处会让"修完再跑还有"反复循环
      // （0727 实测：同一文件第 6 行修掉后第 125 行才暴露）。每文件每规则封顶 20 条防刷屏。
      let m, n = 0;
      while ((m = r.re.exec(text)) !== null && n < 20) {
        n++;
        const line = text.slice(0, m.index).split("\n").length;
        findings.scan.push({ path: rel, line, id: r.id, category: r.category, why: r.why, severity: r.severity, sample: m[0].slice(0, 60) });
        if (m.index === r.re.lastIndex) r.re.lastIndex++; // 零宽匹配防死循环
      }
    }
  }
}

walk(TARGET);

if (args.json) {
  console.log(JSON.stringify({ target: TARGET, profile: PROFILE, counters, findings }, null, 2));
} else {
  console.log(`\n[check-release] target=${TARGET}`);
  console.log(`  profile=${PROFILE}  文件 ${counters.files} / 硬扫 ${counters.scanned}`);
  console.log(`  跳过: 非文本 ${counters.skippedBinary} · 超 ${MAX_KB}KB ${counters.skippedBig} · 依赖缓存目录 ${counters.skippedDirs}`);

  if (findings.residue.length) {
    console.log(`\n  ✗ 机密件残留 ${findings.residue.length} 处:`);
    for (const f of findings.residue.slice(0, 40)) console.log(`      ${f.isDir ? "[DIR ]" : "[FILE]"} ${f.path}   ← 规则 ${f.rule}`);
    if (findings.residue.length > 40) console.log(`      …另有 ${findings.residue.length - 40} 处（--json 看全量）`);
  } else {
    console.log(`\n  ✓ 机密件残留: 0`);
  }

  const blocking = findings.scan.filter((f) => f.severity === "block");
  const warning = findings.scan.filter((f) => f.severity === "warn");

  if (blocking.length) {
    console.log(`\n  ✗ 敏感信息命中（阻断）${blocking.length} 处:`);
    for (const f of blocking.slice(0, 40)) console.log(`      ${f.path}:${f.line}  [${f.category}/${f.id}] ${f.sample}`);
    if (blocking.length > 40) console.log(`      …另有 ${blocking.length - 40} 处（--json 看全量）`);
  } else {
    console.log(`  ✓ 敏感信息命中（阻断）: 0`);
  }

  if (warning.length) {
    console.log(`\n  ⚠ 提示级 ${warning.length} 处（不阻断发布，值得顺手清）:`);
    const byId = {};
    for (const f of warning) (byId[f.id] = byId[f.id] || []).push(f);
    for (const [id, list] of Object.entries(byId)) {
      console.log(`      [${id}] ${list.length} 处 — ${list[0].why.split("。")[0]}`);
      for (const f of list.slice(0, 5)) console.log(`         ${f.path}:${f.line}  ${f.sample}`);
      if (list.length > 5) console.log(`         …另有 ${list.length - 5} 处`);
    }
  }

  if (skippedBigList.length) {
    console.log(`\n  ⚠ 因超限未扫（不代表干净，需要时调 --maxKB）:`);
    for (const s of skippedBigList.slice(0, 15)) console.log(`      ${s}`);
    if (skippedBigList.length > 15) console.log(`      …另有 ${skippedBigList.length - 15} 个`);
  }
}

// 只有残留与 block 级命中构成"不可发布"；warn 级如实报告但不拦
const bad = findings.residue.length + findings.scan.filter((f) => f.severity === "block").length;
const warnCount = findings.scan.filter((f) => f.severity === "warn").length;
console.log(bad ? `\n结论: 不可发布（${bad} 处阻断项）\n` : `\n结论: 可发布${warnCount ? `（另有 ${warnCount} 处提示级，不阻断）` : ""}\n`);
process.exit(bad ? 1 : 0);
