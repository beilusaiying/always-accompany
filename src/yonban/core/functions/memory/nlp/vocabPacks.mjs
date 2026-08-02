// ════════════════════════════════════════════════════════════════════
// vocabPacks.mjs — 词库热插拔后端（导入/导出/启停，多种类包，mtime 热加载，免重启生效）
//
// 功能链：memoryRecall → loadVocabPacks(memDir) → {aliasMap, wordFreq, divergeMap, stopwords, synonyms}（合并 payload 段）
// why：用户/社区可为角色定制词库包（特化域词/打字式词频），热插拔不重启即生效；
//      框架只并进召回已在消费的 map（aliasMap/wordFreq/点1/4/5），打分逻辑不改，无包零行为变化。
// 关联链：
//   ← memoryRecall.mjs（loadVocabPacks 取合并包）
//   ← queryExpand.mjs（点4 divergeMap / 点5 synonyms）
//   → nicerWriteFile.mjs（nicerWriteFileSync，安全写盘包文件）
// 影响范围：读/写 memory/vocab/packs/{id}.json；mtime 变化自动清缓存；单包词条上限 50K 防性能劣化
// ════════════════════════════════════════════════════════════════════
// 凛倾 2026-06-03: "热更新需要和词库一样可以导入和导出, 也就是特化词库或者打字式词库."
//   "你要建立后端, 还有可以多个不同种类的包."
//
// 一个词库包 = 单个自描述 JSON(可导入导出/可手编/可查看), 结构:
//   { manifest: { id, name, kind, type, version, created, enabled }, payload: {...} }
//   type:    specialized(特化域包, 用户/社区做) | typing(打字式: 系统从 vocab/user 学到的导出)
//   kind:    描述性标签(alias/synonym/diverge/wordfreq/stopword/mixed), 不限制 payload 段
//   payload 段(任意组合, 多种类一包或分包均可):
//     aliases:       { 词: [别名] }              → 点3 expandWithAliases
//     synonyms:      { 词: [同义] }              → 点5 补 Cilin
//     diverge:       { 词: [{word,strength}] }   → 点4 补 SWOW(资源自带 strength)
//     word_freq:     { 词: 次数 }                → 点11 userFreqBoost 个性化升权
//     stopwords:     [词]                        → 点1 域内停用(从查询键剔除)
//
// 物理: memory/vocab/packs/{id}.json (per-char). 调用方可对角色级+全局两处分别 load 合并.
// 热(免重启): 照搬 aliasLib.loadAliases 的 mtime 缓存 — packs 目录/文件变了清缓存, 下轮召回自动生效.
//   导入/启停/卸载都改 mtime → 即时生效, 零重启(同既有别名热更新机制).
// 框架: 包只在加载层并进召回"已经在吃的"map(aliasMap/wordFreq)+点1/4/5, 打分逻辑不改.
//   无包安装 = 零行为变化(各段空合并); 有包 = map 变大.
// ════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs";

const PACKS_SUBDIR = "packs";        // memory/vocab/packs/
const MAX_PACK_ENTRIES = 50000;      // 单包词条上限(防超大包拖慢每轮加载); 非魔法权重=性能护栏
const VALID_TYPES = new Set(["specialized", "typing"]);
const PAYLOAD_SECTIONS = ["aliases", "synonyms", "diverge", "word_freq", "stopwords"];

function _readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function _mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function _packsDir(vocabDir) { return path.join(vocabDir, PACKS_SUBDIR); }
function _safeId(id) { return String(id || "").replace(/[^\w.\-一-鿿]/g, "_").slice(0, 80) || "pack"; }

function _listPackFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)); }
  catch { return []; }
}

// mtime 签名: 目录 mtime(增删感知) + 各文件 mtime(编辑感知)
function _sig(dir, files) {
  let s = "" + _mtime(dir);
  for (const f of files.sort()) s += "|" + path.basename(f) + ":" + _mtime(f);
  return s;
}

// ── 校验 manifest + payload(导入/加载前) ──
export function validatePack(pack) {
  if (!pack || typeof pack !== "object") return { ok: false, error: "非对象" };
  const m = pack.manifest;
  if (!m || typeof m !== "object") return { ok: false, error: "缺 manifest" };
  if (!m.id || typeof m.id !== "string") return { ok: false, error: "manifest.id 必须为字符串" };
  if (m.type && !VALID_TYPES.has(m.type)) return { ok: false, error: `非法 type: ${m.type}` };
  const p = pack.payload;
  if (!p || typeof p !== "object") return { ok: false, error: "缺 payload" };
  let entries = 0;
  for (const sec of Object.keys(p)) {
    if (!PAYLOAD_SECTIONS.includes(sec)) continue; // 未知段忽略(向前兼容), 不报错
    const v = p[sec];
    if (sec === "stopwords") { if (!Array.isArray(v)) return { ok: false, error: "stopwords 必须为数组" }; entries += v.length; }
    else { if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: `${sec} 必须为对象` }; entries += Object.keys(v).length; }
  }
  if (entries > MAX_PACK_ENTRIES) return { ok: false, error: `词条数 ${entries} 超上限 ${MAX_PACK_ENTRIES}` };
  return { ok: true, entries };
}

// ── 合并工具(union/相加/取强) ──
function _mergeKV(dst, src) { // {k:[..]} union
  if (!src || typeof src !== "object") return;
  for (const [k, arr] of Object.entries(src)) {
    if (!Array.isArray(arr)) continue;
    const set = (dst[k] ||= new Set());
    for (const v of arr) if (v && v !== k) set.add(v);
  }
}
function _mergeDiverge(dst, src) { // {k:[{word,strength}]} 同词取 max strength
  if (!src || typeof src !== "object") return;
  for (const [k, arr] of Object.entries(src)) {
    if (!Array.isArray(arr)) continue;
    const m = (dst[k] ||= new Map());
    for (const it of arr) {
      const w = it?.word; if (!w || w === k) continue;
      const s = +it.strength || 0;
      m.set(w, Math.max(m.get(w) || 0, s));
    }
  }
}
function _mergeFreq(dst, src) { // {k:n} 相加
  if (!src || typeof src !== "object") return;
  for (const [k, n] of Object.entries(src)) { const v = +n || 0; if (v) dst[k] = (dst[k] || 0) + v; }
}

// ── 加载并合并 enabled 包, mtime 热缓存 ──
//   返回 { aliases:{k:[..]}, synonyms:{k:[..]}, diverge:{k:[{word,strength}]}, wordFreq:{k:n}, stopwords:Set, packs:[{id,enabled,kind,name}] }
const _cache = new Map(); // vocabDir → { sig, merged }
export function loadVocabPacks(vocabDir) {
  const EMPTY = { aliases: {}, synonyms: {}, diverge: {}, wordFreq: {}, stopwords: new Set(), packs: [] };
  if (!vocabDir) return EMPTY;
  const dir = _packsDir(vocabDir);
  const files = _listPackFiles(dir);
  if (files.length === 0) return EMPTY;
  const sig = _sig(dir, files);
  const cached = _cache.get(vocabDir);
  if (cached && cached.sig === sig) return cached.merged;

  const A = {}, S = {}, D = {}, F = {}, SW = new Set(), packs = [];
  for (const f of files.sort()) { // 装序 = 文件名排序(稳定); union/相加无覆盖, 故装序不影响结果
    const pack = _readJson(f);
    if (!validatePack(pack).ok) continue;
    const m = pack.manifest;
    if (m.enabled === false) { packs.push({ id: m.id, enabled: false, kind: m.kind, name: m.name }); continue; }
    packs.push({ id: m.id, enabled: true, kind: m.kind, name: m.name });
    const p = pack.payload || {};
    _mergeKV(A, p.aliases);
    _mergeKV(S, p.synonyms);
    _mergeDiverge(D, p.diverge);
    _mergeFreq(F, p.word_freq);
    if (Array.isArray(p.stopwords)) for (const w of p.stopwords) SW.add(w);
  }
  const flatKV = (obj) => { const o = {}; for (const [k, set] of Object.entries(obj)) o[k] = [...set]; return o; };
  const flatDiv = (obj) => { const o = {}; for (const [k, m] of Object.entries(obj)) o[k] = [...m.entries()].map(([word, strength]) => ({ word, strength })); return o; };
  const merged = { aliases: flatKV(A), synonyms: flatKV(S), diverge: flatDiv(D), wordFreq: F, stopwords: SW, packs };
  _cache.set(vocabDir, { sig, merged });
  return merged;
}

// ── 列出已装包(含禁用) ──
export function listPacks(vocabDir) {
  const out = [];
  for (const f of _listPackFiles(_packsDir(vocabDir))) {
    const pack = _readJson(f);
    if (pack?.manifest) out.push({ ...pack.manifest, _file: path.basename(f), _sections: Object.keys(pack.payload || {}) });
  }
  return out;
}

// ── 导入: 校验 → 落盘 packs/{id}.json → 清缓存(下轮热加载) ──
export function importPack(vocabDir, packObjOrStr) {
  let pack = packObjOrStr;
  if (typeof packObjOrStr === "string") { try { pack = JSON.parse(packObjOrStr); } catch (e) { return { success: false, error: "JSON 解析失败: " + e.message }; } }
  const v = validatePack(pack);
  if (!v.ok) return { success: false, error: v.error };
  const dir = _packsDir(vocabDir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  if (pack.manifest.enabled === undefined) pack.manifest.enabled = true;
  if (!pack.manifest.imported) pack.manifest.imported = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, _safeId(pack.manifest.id) + ".json");
  try { nicerWriteFileSync(file, JSON.stringify(pack, null, 2), "utf8"); }
  catch (e) { return { success: false, error: "写盘失败: " + e.message }; }
  _cache.delete(vocabDir);
  return { success: true, id: pack.manifest.id, file, entries: v.entries };
}

// ── 启停: 翻 manifest.enabled(不删文件) → 清缓存 ──
export function setPackEnabled(vocabDir, id, enabled) {
  const file = path.join(_packsDir(vocabDir), _safeId(id) + ".json");
  const pack = _readJson(file);
  if (!pack?.manifest) return { success: false, error: "包不存在: " + id };
  pack.manifest.enabled = !!enabled;
  try { nicerWriteFileSync(file, JSON.stringify(pack, null, 2), "utf8"); }
  catch (e) { return { success: false, error: e.message }; }
  _cache.delete(vocabDir);
  return { success: true, id, enabled: !!enabled };
}

// ── 卸载: 删文件 → 清缓存 ──
export function uninstallPack(vocabDir, id) {
  const file = path.join(_packsDir(vocabDir), _safeId(id) + ".json");
  try { fs.unlinkSync(file); _cache.delete(vocabDir); return { success: true, id }; }
  catch (e) { return { success: false, error: e.message }; }
}

// ── 导出打字式词库: 快照 vocab/user 的自学数据 → typing 包对象(调用方序列化/下载) ──
//   vocabDir = memory/vocab; 读 user/ 下 word_freq + aliases_auto/deep(+可选 cooccur).
export function exportTypingPack(vocabDir, opts = {}) {
  const userDir = path.join(vocabDir, "user");
  const wfRaw = _readJson(path.join(userDir, "word_freq.json")) || {};
  const wf = {}; // 包内 word_freq schema = {词:数字}; 用户库新 schema {词:{c,t}} → 导出展平取 c(旧 number 透传)
  for (const [w, v] of Object.entries(wfRaw)) { const c = typeof v === "number" ? v : (v && v.c) || 0; if (c) wf[w] = c; }
  const aliases = {};
  for (const fn of ["aliases_auto.json", "aliases_deep.json"]) {
    const a = _readJson(path.join(userDir, fn))?.alias || {};
    for (const [k, arr] of Object.entries(a)) { if (!Array.isArray(arr)) continue; const cur = (aliases[k] ||= []); for (const x of arr) if (x !== k && !cur.includes(x)) cur.push(x); }
  }
  const payload = { word_freq: wf, aliases };
  if (opts.includeCooccur) payload.user_cooccur = _readJson(path.join(userDir, "user_cooccur.json")) || {};
  return {
    manifest: {
      id: opts.id || ("typing-export-" + Date.now()),
      name: opts.name || "打字式词库导出",
      kind: "mixed", type: "typing", version: "1.0",
      created: new Date().toISOString().slice(0, 10), enabled: true,
    },
    payload,
  };
}

export default { loadVocabPacks, listPacks, importPack, setPackEnabled, uninstallPack, exportTypingPack, validatePack };
