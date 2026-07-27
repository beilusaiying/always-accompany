/**
 * [extract_localstorage_keys.mjs] — storage-keys.mjs 的受控生成脚本（唯一可写 KEYS 表的入口）。
 *
 * 功能链：node extract_localstorage_keys.mjs → 扫描前端域（public/**）全部 .mjs/.html 中
 *   真正流入 localStorage / storage 封装的字面 key（含局部常量中转）→ 与现表 KEYS 已有 key 求并集
 *   → 保序生成 storage-keys.mjs（现有行原序保留，新键追加到表尾）→ 覆盖写回。
 *
 * why：storage-keys.mjs 头注释声称"由脚本生成、禁手敲"，但脚本历史上丢失（T041 执行分身 find 无果），
 *   导致新出现的 localStorage key 无法按规则收编。本脚本重建该受控生成入口，恢复"脚本可重跑、不留静态快照"
 *   的框架契约（凛倾重构锚点），杜绝手敲 typo/漂移。key 字面值保持原样、不加前缀（兼容浏览器旧数据）。
 *
 * 扫描判据（数据流精准，只认真正当 localStorage key 用的字面，杜绝 CSS class / DOM id / CustomEvent 名误报）：
 *   A. localStorage.getItem/setItem/removeItem("字面")     —— 直接内联
 *   B. storage.get/set/remove("字面")                       —— 经 storage.mjs 封装的内联
 *   C. const/let/var VAR = "字面"，且 VAR 被 localStorage.xxx(VAR) 引用 —— 局部常量中转
 *   （storage.get/set(KEYS.X) 这类已收口的消费不产生字面，其 key 由"现表并集"保留，不依赖扫描。）
 *
 * 排序规则：**保序**——现有 KEYS 行按原文件顺序原样保留（历史顺序含手工插入痕迹，非严格字母序，
 *   强行重排会污染 diff、无收益）；本次新扫到、现表没有的 key 追加到表尾（`}` 之前），常量名由字面
 *   经 keyToConstName() 规范化（大写、连字符→下划线）生成。
 *
 * 关联链：
 *   → storage-keys.mjs（本脚本的唯一写目标）
 *   同目录 state/ 下与被生成文件就近放置（头注释未指定目录，无 tools/ 同族脚本，故就近）。
 *
 * 影响范围：
 *   - 运行本脚本会覆盖 storage-keys.mjs。默认 --check（dry-run）只对拍不写；--write 才落盘。
 *   - 新键入表 → 消费方可改用 KEYS.XXX；删键需先清理消费方（本脚本不删已入表 key，只增不减，防误删活跃 key）。
 *
 * 用法：
 *   node extract_localstorage_keys.mjs           # dry-run：打印扫描结果与对现表的 diff，不写文件
 *   node extract_localstorage_keys.mjs --write    # 生成并覆盖 storage-keys.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本脚本位于 public/src/shared/state/；前端域扫描根 = public/（向上 3 级）。
const SCAN_ROOT = path.resolve(__dirname, "..", "..", "..");
const KEYS_FILE = path.join(__dirname, "storage-keys.mjs");

const SCAN_EXTS = new Set([".mjs", ".html"]);
const SKIP_DIRS = new Set(["node_modules", "vendor"]);

/** 递归收集待扫文件 */
function collectFiles(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(p, acc);
    else if (SCAN_EXTS.has(path.extname(ent.name))) acc.push(p);
  }
  return acc;
}

/**
 * 从单个文件文本提取真正当 localStorage key 用的字面。
 * @returns {Set<string>}
 */
function extractKeysFromText(text) {
  const found = new Set();

  // A. localStorage.getItem/setItem/removeItem("字面")
  const reLS = /localStorage\.(?:getItem|setItem|removeItem)\(\s*["']([^"']+)["']/g;
  // B. storage.get/set/remove("字面")
  const reStorage = /\bstorage\.(?:get|set|remove)\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = reLS.exec(text))) found.add(m[1]);
  while ((m = reStorage.exec(text))) found.add(m[1]);

  // C. 局部常量中转：先找出被 localStorage.xxx(VAR) 引用的标识符，再解析其字面赋值。
  const varRefs = new Set();
  const reVarRef = /localStorage\.(?:getItem|setItem|removeItem)\(\s*([A-Za-z_$][\w$]*)\b/g;
  while ((m = reVarRef.exec(text))) varRefs.add(m[1]);
  for (const v of varRefs) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reAssign = new RegExp(
      "\\b(?:const|let|var)\\s+" + esc + "\\s*=\\s*[\"']([^\"']+)[\"']",
      "g",
    );
    let ma;
    while ((ma = reAssign.exec(text))) found.add(ma[1]);
  }

  return found;
}

/** 全域扫描，返回排序后的字面 key 数组 */
function scanKeys() {
  const files = collectFiles(SCAN_ROOT, []);
  const all = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const k of extractKeysFromText(text)) all.add(k);
  }
  return [...all].sort();
}

/**
 * 解析现表：返回 { entries: [{name, value}], values: Set }，entries 按原文件顺序。
 */
function parseCurrentTable() {
  const src = fs.readFileSync(KEYS_FILE, "utf8");
  const entries = [];
  const values = new Set();
  const reEntry = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*["']([^"']+)["']\s*,?\s*$/gm;
  let m;
  while ((m = reEntry.exec(src))) {
    entries.push({ name: m[1], value: m[2] });
    values.add(m[2]);
  }
  return { entries, values };
}

/** 字面 key → KEYS 常量名（大写、非字母数字→下划线）。仅用于新键追加。 */
function keyToConstName(key) {
  return key.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

/** 生成 storage-keys.mjs 全文（头注释固定 + KEYS 块保序） */
function renderFile(entries) {
  const header = `/**
 * [storage-keys.mjs] — 前端 localStorage key 集中常量表（唯一权威来源）。
 *
 * 功能链：受控脚本 extract_localstorage_keys.mjs 扫全部 .mjs 中字面量 key → 去重生成本文件
 *   → storage-keys.mjs export KEYS 冻结对象 → storage.mjs re-export → 全前端消费方通过 KEYS.XXX 读写 key。
 *
 * why：历史上 localStorage key 字符串散落各文件手写，typo 导致读到错 key 的 bug 难以追查，
 *   且 key 改名时要全局搜改、极易漏改。本文件将所有 key 字面值收口为一处，
 *   禁止手敲常量名，由脚本自动生成以防 typo 和漂移（R2 / P2大重构）。
 *   key 字面值故意保持原始字符串不变，不加命名空间前缀——兼容用户浏览器中已存的旧数据，
 *   加前缀会导致旧数据全部失效（用户偏好重置）。Object.freeze() 防止运行时意外写入。
 *
 * 关联链：
 *   → storage.mjs（re-export 本文件 KEYS，消费方通常从 storage.mjs 一并 import）
 *   被 import → 全前端所有读写 localStorage 的模块（通过 storage.mjs 间接）
 *   生成来源 → extract_localstorage_keys.mjs 受控脚本（禁止手工增减常量）
 *
 * 影响范围：
 *   - 改动 key 字面值 → 直接导致浏览器旧存储读不到（用户偏好全部重置），高风险
 *   - 新增 key → 需先在脚本扫描后生成，禁止手敲
 *   - 删除 key → 对应模块的 KEYS.XXX 引用会报 undefined，需同步清理消费方
 *
 * 使用效果：
 *   - 消费方写 KEYS.BEILU_ACTIVE_MODE 而非字符串 "beilu-active-mode" → 拼写错误在开发期即可被 IDE 发现
 *   - 用户的所有浏览器端偏好（主题/模式/字体/聊天ID等）均通过这张表寻址
 */
// key 字面值保持不变（不加命名空间前缀，兼容浏览器中已存的旧数据）。
export const KEYS = Object.freeze({
`;
  const body = entries.map((e) => `  ${e.name}: ${JSON.stringify(e.value)},`).join("\n");
  return header + body + "\n});\n";
}

/** 主流程 */
function main() {
  const write = process.argv.includes("--write");
  const scanned = scanKeys();
  const { entries, values } = parseCurrentTable();

  // 新键 = 扫到但现表没有的（保序：现表原序 + 新键按扫描顺序追加）
  const newKeys = scanned.filter((k) => !values.has(k));
  // 现表有但本次没扫到的（收口后消费方无字面，属正常；仅报告，不删）
  const scannedSet = new Set(scanned);
  const unscanned = entries.filter((e) => !scannedSet.has(e.value)).map((e) => e.value);

  const finalEntries = entries.concat(
    newKeys.map((k) => ({ name: keyToConstName(k), value: k })),
  );

  console.log(`[extract] 扫描根: ${SCAN_ROOT}`);
  console.log(`[extract] 扫到字面 key: ${scanned.length}  现表 key: ${values.size}`);
  console.log(`[extract] 新增（扫到但不在现表，将追加）: ${newKeys.length}`);
  for (const k of newKeys) console.log(`  + ${keyToConstName(k)}: "${k}"`);
  console.log(`[extract] 现表中未被本次扫到的 key（收口后无字面，保留不删）: ${unscanned.length}`);

  const out = renderFile(finalEntries);

  if (write) {
    fs.writeFileSync(KEYS_FILE, out, "utf8");
    console.log(`[extract] 已写入 ${KEYS_FILE}（共 ${finalEntries.length} 键）`);
  } else {
    // dry-run：与现表逐行对拍，输出 diff
    const cur = fs.readFileSync(KEYS_FILE, "utf8");
    if (out === cur) {
      console.log("[extract] dry-run：产出与现表逐字节一致（幂等）。");
    } else {
      const curLines = cur.split("\n");
      const outLines = out.split("\n");
      const added = outLines.filter((l) => !curLines.includes(l));
      const removed = curLines.filter((l) => !outLines.includes(l));
      console.log("[extract] dry-run diff（+ 生成新增 / - 现表将失去）:");
      for (const l of removed) console.log(`  - ${l}`);
      for (const l of added) console.log(`  + ${l}`);
    }
  }
}

main();
