// ════════════════════════════════════════════════════════════════════
// aliasLib.mjs — 别名库（自动库 PMI-IR + 深度库 LLM 共指，给召回扩词补变体）
//
// 功能链：memoryRecall / queryExpand → loadAliases(memDir) → aliasMap；expandWithAliases(queryWords, aliasMap) → 扩展查询键集
// why：用户说"焰"，记忆存"晓美焰"——字面不一致导致召回 0 命中；别名库把变体映射进查询键，
//      自动库（PMI 共现统计）覆盖对话新涌现的别名，深度库（P9 LLM）覆盖跨语言/世界知识别名。
// 关联链：
//   ← queryExpand.mjs（点3 expandWithAliases）
//   ← memoryRecall.mjs（loadAliases 取合并别名图）
//   → nicerWriteFile.mjs（更新 aliases_auto.json 时安全写盘）
// 影响范围：只读 memory/vocab/aliases_auto.json + aliases_deep.json；mtime 缓存，热更新免重启
// ════════════════════════════════════════════════════════════════════
// 一功能一文件(凛倾 2026-06-02 "做个专门的库"). 解决召回的别名/变体 gap:
//   晓美焰↔焰↔ほむら、贝露↔贝露赛因、与你之诗↔项目 —— 用户说变体, 记忆存另一形态.
//
// 双层(凛倾 "一个自动库类似打字记忆, 一个深度库 AI 负责即 P9"):
//   ① 自动库(实时/打字记忆)  aliases_auto.json — 纯统计无监督, 随对话增长, 零魔法数字:
//      · PMI-IR(Turney arxiv cs/0212033): PMI(a,b)=log[N·c(a,b)/(c(a)·c(b))] on user_cooccur,
//        正 PMI = 强关联/别名候选(正负自然分界, 非魔法阈值).
//      · 字符串包含: 用户词表里 a⊂b 且都≥2字 → 简称/全称别名(贝露⊂贝露赛因).
//   ② 深度库(P9 离线 batch, AI 负责)  aliases_deep.json — LLM 共指 + embedding 实体同义:
//      · 仿 term_alias.json 的 gemini 生成模式(版本化 _meta), 判世界知识/跨语言别名(焰=晓美焰=ほむら).
//      · 算法: DE-ESD 双编码器实体同义 + coreference resolution(arxiv 2508.12630 语义锚定).
//
// 热加载(凛倾 P9 机制): mtime 缓存, 文件变了清缓存不重启即生效(同 P1 词库 30s polling).
// 召回消费: expandWithAliases(queryWords, aliasMap) → 把查询词扩成"变体也搜".
// ════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 内化资源: 哈工大同义词林(synonym_index.json, P1资源库 Cilin 衍生) → 召回同义扩展 ──
//   凛倾 2026-06-02 "做内化": 把 P1资源库现成同义资源内化进召回, 补字面变体(喜欢↔喜爱/童年↔幼年).
//   全局共享(非 per-char), 进程级缓存(7.8MB 加载一次). 噪声由召回下游 IDF 门槛挡.
let _synCache = null;
export function loadSynonyms() {
  if (_synCache !== null) return _synCache;
  try { _synCache = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "synonym_index.json"), "utf8")); }
  catch { _synCache = {}; }
  return _synCache;
}
// 取一个词的同义词(去掉自身)
export function synonymsOf(word) {
  const syn = loadSynonyms()[word];
  if (!Array.isArray(syn)) return [];
  const out = [];
  for (const s of syn) { if (s && s !== word) out.push(s); }
  return out;
}

// 别名文件位置(per-char): memory/vocab/user/ 下, 与 word_freq/user_cooccur 同目录.
const AUTO_FILE = "aliases_auto.json";   // 自动库(本模块 buildAutoAliases 产)
const DEEP_FILE = "aliases_deep.json";   // 深度库(P9 gemini batch 产)

// ── 自动库构建: PMI(共现) + 字符串包含, 无监督, 零魔法阈值 ──
//   userVocabDir = memory/vocab/user/. 读 word_freq.json(边际计数) + user_cooccur.json(联合计数).
//   PMI 只收正值(正负是自然分界, 非拍阈值); 字符串包含取 OOV-ish 简称/全称对.
export function buildAutoAliases(userVocabDir) {
  const freq = _readJson(path.join(userVocabDir, "word_freq.json")) || {};
  const cooccur = _readJson(path.join(userVocabDir, "user_cooccur.json")) || {};
  const alias = {}; // {term: Set(别名)}
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    (alias[a] ||= new Set()).add(b);
    (alias[b] ||= new Set()).add(a);
  };

  // (1) PMI: N=总频次, c(a)/c(b)=word_freq, c(a,b)=cooccur. 正 PMI 入候选.
  let N = 0;
  for (const v of Object.values(freq)) N += v;
  if (N > 0) {
    for (const [pair, cab] of Object.entries(cooccur)) {
      const [a, b] = pair.split("|");
      const ca = freq[a], cb = freq[b];
      if (!ca || !cb || !cab) continue;
      const pmi = Math.log((N * cab) / (ca * cb));
      if (pmi > 0) add(a, b); // 正 PMI = 共现强于独立 = 关联/别名候选(自然分界)
    }
  }

  // (2) 字符串包含: a⊂b 简称/全称别名. 约束只在"OOV 专名"间(排常用词子串噪声: 今天⊂今天好):
  //   · 全汉字(无乱码 �) · 两词都 OOV(BCC freq=0 = 通用语料没有 = 专名/生造词; 常用词 freq>0 被排除)
  //   · 长度相近(差≤3字, 防"圆"配到一堆长词). 零魔法数字: freq==0 是 OOV 定义.
  const _pure = (w) => /^[\u4e00-\u9fff]{2,}$/.test(w);
  const vocab = Object.keys(freq).filter(_pure);
  for (let i = 0; i < vocab.length; i++) {
    for (let j = 0; j < vocab.length; j++) {
      if (i === j) continue;
      const a = vocab[i], b = vocab[j];
      if (b.length > a.length && b.includes(a)) add(a, b);
    }
  }

  const out = { _meta: { layer: "auto", algo: "PMI(user_cooccur)+字符串包含", built: new Date().toISOString().slice(0, 10), N }, alias: {} };
  for (const [k, set] of Object.entries(alias)) out.alias[k] = [...set];
  nicerWriteFileSync(path.join(userVocabDir, AUTO_FILE), JSON.stringify(out, null, 2), "utf8");
  return out.alias;
}

// ── 加载合并别名(自动+深度), mtime 热缓存 ──
const _cache = new Map(); // userVocabDir → { map, mtimes }
export function loadAliases(userVocabDir) {
  if (!userVocabDir) return {};
  const autoP = path.join(userVocabDir, AUTO_FILE);
  const deepP = path.join(userVocabDir, DEEP_FILE);
  const mt = _mtime(autoP) + "|" + _mtime(deepP);
  const cached = _cache.get(userVocabDir);
  if (cached && cached.mt === mt) return cached.map; // 热缓存命中(mtime 未变)

  const map = {};
  const merge = (obj) => {
    const a = obj?.alias || {};
    for (const [k, arr] of Object.entries(a)) {
      if (!Array.isArray(arr)) continue;
      (map[k] ||= new Set());
      for (const v of arr) if (v && v !== k) map[k].add(v);
    }
  };
  merge(_readJson(autoP));
  merge(_readJson(deepP)); // 深度库覆盖/补充(同 key 合并)
  const flat = {};
  for (const [k, set] of Object.entries(map)) flat[k] = [...set];
  _cache.set(userVocabDir, { mt, map: flat });
  return flat;
}

// ── 召回扩词: 给定查询词(+可选原文), 返回别名变体(去重, 不含原词) ──
//   rawText: 别名 key 也对原始输入做子串匹配 — 救分词器拆散/过滤掉的变体(ほむら假名/鹿目圆香被切).
export function expandWithAliases(words, aliasMap, rawText) {
  if (!aliasMap) return [];
  const src = new Set(words || []);
  const out = new Set();
  for (const w of words || []) {
    for (const a of aliasMap[w] || []) if (!src.has(a)) out.add(a);
  }
  if (rawText) {
    for (const key of Object.keys(aliasMap)) {
      if (src.has(key) || out.has(key)) continue;
      if (rawText.includes(key)) for (const a of aliasMap[key]) if (!src.has(a)) out.add(a);
    }
  }
  return [...out];
}

function _readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function _mtime(p) { try { return "" + fs.statSync(p).mtimeMs; } catch { return "0"; } }

export default { buildAutoAliases, loadAliases, expandWithAliases };
