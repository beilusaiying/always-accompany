// build-release.mjs — 按单源清单产出/整理干净的发布物
//
// why: 发布瘦身此前靠人工 robocopy + 人工记得删什么（0716/0719 同步记录里每次重列一遍），
//      人一忘就把机密带出去。改成读 release-manifest.json 的单点执行，规则只有一份。
// 功能链: release-manifest.json → _manifest-lib.mjs（匹配语义）→ [本脚本] → 干净发布物
//          → check-release.mjs 复扫兜底
//
// 用法:
//   copy  模式（从本体产出新副本）:
//     node scripts/release/build-release.mjs --mode=copy --src=<本体> --out=<目标> --profile=public
//   prune 模式（在已有副本上原地清理，配合既有 robocopy playbook）:
//     node scripts/release/build-release.mjs --mode=prune --target=<副本> --profile=exe --yes
//
//   --mirror  仅 copy 模式：复制后删除 out 中源已不存在的文件（对齐 robocopy /MIR），
//             但 exclude 命中的路径一律跳过删除——exe 包的 .deno_dir(506MB 构建期产物，
//             本体没有、不可再生)与 node_modules 正是靠这条豁免活下来的。
//
//   --profile=public  发布给公共仓：机密件 + 运行时产物全排除
//   --profile=exe     exe 离线包：机密件排除，但放行 node_modules/.deno_dir（离线运行必需）
//   --profile=full    只排运行时产物，机密件保留（私仓完整版用）
//   不带 --yes = dry-run，只报告不动文件。

import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { loadManifest, compileExcludes, matchExclude, hasKeepUnder } from "./_manifest-lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const MODE = args.mode || "copy";
const PROFILE = args.profile || "public";
const APPLY = args.yes === true;

// exe 离线包必须带依赖才能跑；这两条是 runtimeArtifacts 里唯一的 profile 例外。
const EXE_ALLOW = ["**/node_modules/", "**/.deno_dir/"];

function buildRules() {
  const manifest = loadManifest(args.manifest);
  // full = 私仓完整版：机密件不排
  const skipGroups = PROFILE === "full" ? ["confidential"] : [];
  const rules = compileExcludes(manifest, { skipGroups });
  if (PROFILE === "exe" || PROFILE === "full") {
    rules.ex = rules.ex.filter((e) => !EXE_ALLOW.includes(e.rule));
  }
  return rules;
}

function walk(root, cb, base = root) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = join(root, e.name);
    const rel = relative(base, abs).replace(/\\/g, "/");
    // 目录命中 → 整棵跳过，不再下钻（十万级 node_modules 靠这个才不至于逐文件判断）
    if (cb(abs, rel, e.isDirectory()) === "skip") continue;
    if (e.isDirectory()) walk(abs, cb, base);
  }
}

const stats = { kept: 0, kbKept: 0, excluded: 0, kbExcluded: 0, byGroup: {} };
const copiedRel = new Set(); // copy 模式下本次覆盖到的相对路径，--mirror 据此判孤儿
function note(hit, abs, isDir) {
  const key = `${hit.group}:${hit.rule}`;
  stats.byGroup[key] = stats.byGroup[key] || { files: 0, kb: 0 };
  let kb = 0, files = 0;
  if (isDir) {
    walk(abs, (a, _r, d) => { if (!d) { files++; try { kb += statSync(a).size / 1024; } catch {} } });
  } else {
    files = 1;
    try { kb = statSync(abs).size / 1024; } catch {}
  }
  stats.byGroup[key].files += files;
  stats.byGroup[key].kb += kb;
  stats.excluded += files;
  stats.kbExcluded += kb;
}

function run() {
  const rules = buildRules();

  if (MODE === "copy") {
    const src = args.src, out = args.out;
    if (!src || !out) throw new Error("copy 模式需要 --src 与 --out");
    if (!existsSync(src)) throw new Error(`--src 不存在: ${src}`);
    walk(src, (abs, rel, isDir) => {
      const hit = matchExclude(rules, rel);
      if (hit) {
        // 目录里埋着 keep 例外 → 不能整棵剪枝，下钻逐文件判定
        if (isDir && hasKeepUnder(rules, rel)) return;
        note(hit, abs, isDir);
        return "skip";
      }
      if (isDir) return;
      stats.kept++;
      try { stats.kbKept += statSync(abs).size / 1024; } catch {}
      copiedRel.add(rel);
      if (APPLY) {
        const dst = join(out, rel);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(abs, dst);
      }
    });

    // --mirror: 清掉 out 里源已不存在的孤儿（本体删掉的插件会一直留在旧发布物里）。
    // exclude 命中的路径整棵跳过——它们不由 copy 管理（.deno_dir/node_modules 靠这条保命）。
    if (args.mirror && existsSync(out)) {
      const orphans = [];
      walk(out, (abs, rel, isDir) => {
        if (matchExclude(rules, rel)) return "skip";
        if (isDir) return;
        if (!copiedRel.has(rel)) orphans.push({ abs, rel });
      });
      stats.orphans = orphans.length;
      if (APPLY) for (const o of orphans) rmSync(o.abs, { force: true });
      if (orphans.length) {
        console.log(`\n  [mirror] 源已不存在的孤儿 ${orphans.length} 个${APPLY ? "（已删）" : "（dry-run 未删）"}:`);
        for (const o of orphans.slice(0, 20)) console.log(`      ${o.rel}`);
        if (orphans.length > 20) console.log(`      …另有 ${orphans.length - 20} 个`);
      }
    }
  } else if (MODE === "prune") {
    const target = args.target;
    if (!target) throw new Error("prune 模式需要 --target");
    if (!existsSync(target)) throw new Error(`--target 不存在: ${target}`);
    const doomed = [];
    walk(target, (abs, rel, isDir) => {
      const hit = matchExclude(rules, rel);
      if (hit) {
        // 同 copy：目录内有 keep 例外就下钻，否则会把 tokenizer.mjs 一并删掉
        if (isDir && hasKeepUnder(rules, rel)) return;
        note(hit, abs, isDir);
        doomed.push(abs);
        return "skip";
      }
      if (!isDir) {
        stats.kept++;
        try { stats.kbKept += statSync(abs).size / 1024; } catch {}
      }
    });
    if (APPLY) for (const d of doomed) rmSync(d, { recursive: true, force: true });
  } else {
    throw new Error(`未知 --mode=${MODE}（可选 copy | prune）`);
  }

  const mb = (kb) => (kb / 1024).toFixed(1);
  console.log(`\n[build-release] mode=${MODE} profile=${PROFILE} ${APPLY ? "APPLY" : "DRY-RUN（加 --yes 才真正执行）"}`);
  console.log(`  保留: ${stats.kept} 文件 / ${mb(stats.kbKept)} MB`);
  console.log(`  剔除: ${stats.excluded} 文件 / ${mb(stats.kbExcluded)} MB`);
  const rows = Object.entries(stats.byGroup).filter(([, v]) => v.files > 0).sort((a, b) => b[1].kb - a[1].kb);
  if (rows.length) {
    console.log(`  ── 按规则 ──`);
    for (const [k, v] of rows) console.log(`    ${k.padEnd(58)} ${String(v.files).padStart(7)} 文件 ${mb(v.kb).padStart(9)} MB`);
  }
  const zero = Object.entries(stats.byGroup).length;
  if (PROFILE !== "full" && zero === 0) console.log(`  ⚠ 零命中：确认 --src/--target 指对了根目录（规则是相对仓库根的路径）`);
}

run();
