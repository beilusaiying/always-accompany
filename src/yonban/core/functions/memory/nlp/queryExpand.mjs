// ════════════════════════════════════════════════════════════════════
// queryExpand.mjs — 查询扩词 / 召回侧发散编排（分词→别名→SWOW→同义→上下文，memoryRecall 的前置）
//
// 功能链：memoryRecall → expandQuery(text, memDir, opts) → {baseWords, divMap, divergedWords, ctxWords}
// why：召回需把用户原始输入扩展成更大的"查询键集"才能命中多种记忆表达；
//      本文件只编排 5 个扩词步骤（点1分词/点3别名/点4SWOW/点5同义/点6上下文），发散数学在各资源模块。
// 关联链：
//   ← memoryRecall.mjs（expandQuery + _extractQueryWords + _isNounish）
//   → wordCoords.mjs（swowDiverge，点4 SWOW 发散）
//   → aliasLib.mjs（expandWithAliases/synonymsOf，点3/点5）
//   → wordClassify.mjs（classifyWord，名词性闸 nounDiv）
// 影响范围：纯计算只读，返回扩词集合对象；jieba 加载失败时 fallback runStep1Extract 贪心分词
// ════════════════════════════════════════════════════════════════════
// 一功能一文件(凛倾): 本文件只把"用户输入 → 召回匹配键集"这段(点1/3/4/5/6)独立出来,
//   不做条目匹配/打分/排序(那是 memoryRecall.mjs 的召回主体).
//
// 职责: 输入文本 → 分词(点1) → 别名扩展(点3) → SWOW 发散(点4) + 同义词林(点5) + 上下文补键(点6)
//   产出: { baseWords0, baseWords, divMap, divergedWords, ctxWords }
//   baseWords  = 原词 ∪ 别名(权 1.0)
//   divMap     = 发散/同义/上下文词 → strength(SWOW 资源自带; 同义/上下文 = 0, 只粗筛捞候选)
//
// 发散算法本体在外部资源模块: swowDiverge(wordCoords) / synonymsOf+expandWithAliases(aliasLib).
//   本文件只编排调用 + nounDiv(动词不发散)的名词性闸. 不实现发散数学.
// ════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import { findResource } from "../p1/p1_resdir.mjs";  // P1 单一资源根
import { swowDiverge } from "./wordCoords.mjs";
import { runStep1Extract } from "./bccTokenize.mjs"; // P1 归档 2026-07-16:原 test/selfDrivenP1_utils.mjs 随 P1 迁出,分词函数抽至主线层(实现保形)
import { expandWithAliases, synonymsOf } from "./aliasLib.mjs";
import { classifyWord } from "./wordClassify.mjs";

// jieba 只负责分词(不参与过滤). 失败 fallback 到 runStep1Extract 贪心分词.
let _jiebaCut = null;
let _jiebaTag = null; // 词性标注(posseg): 实验 nounOnly 用 — 只取实质名词作匹配键, 动词/副词当噪音
try { const _jm = await import("jieba-wasm"); _jiebaCut = _jm.cut; _jiebaTag = _jm.tag; } catch { _jiebaCut = null; _jiebaTag = null; }

// ════════════════════════════════════════════════════════════════════
// [词库辅助·额外提取] 分词器为主, 词库包为辅助. 凛倾 2026-06-03:
//   "分词器为主, 词库包为辅助, 也就是额外提取." (修正"先于拆分"=别让词库改写 jieba 输出)
//   机制: jieba 正常切分(权威, 不动), 另从原文扫出出现的词库词当**补充键**并入, 两边取并集.
//   → 不丢信息(jieba token 全留)、不造垃圾(不从词中间贪心咬)、不过合并(jieba 边界不改).
//     实验证: 贪心 protect-before 在大噪声词典上吞标题+造"今/天天/气"垃圾; 额外提取是加法, 无此患.
//   对比 jieba.add_word: 那是戳全局词典(持久/不可移除/跨角色污染); 本机制 per-call 无状态.
// ════════════════════════════════════════════════════════════════════
const _CJK_RE = /[\u3400-\u9fff]/;
// 词库词集 → 可作"额外提取"键的词(多字 CJK; 单字交 jieba, 无需额外提取)
function _buildPackWordSet(pv) {
  const s = new Set();
  const add = (w) => { if (typeof w === "string" && w.length >= 2 && _CJK_RE.test(w)) s.add(w); };
  for (const src of [pv.aliases, pv.synonyms]) {
    if (src) for (const [k, arr] of Object.entries(src)) { add(k); if (Array.isArray(arr)) for (const v of arr) add(v); }
  }
  if (pv.diverge) for (const [k, arr] of Object.entries(pv.diverge)) { add(k); if (Array.isArray(arr)) for (const it of arr) add(it && it.word); }
  if (pv.wordFreq) for (const k of Object.keys(pv.wordFreq)) add(k);
  return s;
}
// 额外提取: 从原文里捞出所有出现的词库词(各起点各长度全收, 加法不消耗 → 与 jieba token 并集).
//   不破坏 jieba 切分, 仅补充 jieba 没切出的整词(五条悟/魔法少女). maxLen 据集中最长词, 封顶 8.
function _extractPackWords(text, packSet) {
  if (!packSet || packSet.size === 0 || !text) return [];
  let maxLen = 2; for (const w of packSet) if (w.length > maxLen) maxLen = w.length;
  if (maxLen > 8) maxLen = 8;
  const found = [], seen = new Set();
  for (let i = 0; i < text.length; i++) {
    for (let len = Math.min(maxLen, text.length - i); len >= 2; len--) {
      const sub = text.substring(i, i + len);
      if (packSet.has(sub) && !seen.has(sub)) { seen.add(sub); found.push(sub); }
    }
  }
  return found;
}

// 凛倾 2026-06-03: "只看实质名词; 动词副词当噪音; 名词 或 单个的/非记录的词 按名词处理".
//   动词/副词噪音是 SWOW 误召源头(想/明白/记得→理解/记忆). 单字/OOV 默认按名词留(规避红线"POS误杀焰").
//   POS 资源: 首选 HanLP CoreNatureDictionary(词→词性频次, 词典确定查询, 15万词). 缺词典时 fallback jieba tag.
//   规则: 含名词性(n*/vn 动名词) → 当名词留; 纯动词/副词/形容词 → 噪音剔; 单字/未收录 → 留.
let _coreNaturePOS = null; // Map<词, hasNoun:bool>  懒加载
function _loadCoreNaturePOS() {
  if (_coreNaturePOS !== null) return _coreNaturePOS;
  _coreNaturePOS = new Map();
  // P0-2 起统一走 p1_resdir.mjs 定位; 缺失则空 Map(自动 fallback jieba tag).
  const cand = [findResource("CoreNatureDictionary.txt")].filter(Boolean);
  for (const p of cand) {
    let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
    for (const line of txt.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      let hasNoun = false;
      for (let i = 1; i < parts.length; i += 2) { const t = parts[i]; if (t && (t[0] === "n" || t === "vn")) { hasNoun = true; break; } }
      _coreNaturePOS.set(parts[0], hasNoun);
    }
    break;
  }
  return _coreNaturePOS;
}
const _POS_NOISE = /^(v|vd|vn|vf|vx|vi|vl|vg|vshi|vyou|d|df|dg)$/; // jieba fallback: 动词全家 + 副词
export function _isNounish(word, tag) {
  if (word.length <= 1) return true;            // 单字按名词(凛倾红线: POS 对单字失效, 不杀焰)
  const core = _loadCoreNaturePOS();
  if (core.size) {
    if (core.has(word)) return core.get(word);  // 词典确定: 含名词性留, 纯动/副/形剔
    return true;                                // 未收录(英文专名/OOV/新词) → 按名词留
  }
  if (tag === "eng" || tag === "x") return true; // fallback: jieba — 英文/未登录按名词
  return !_POS_NOISE.test(tag);
}

// ════════════════════════════════════════════════════════════════════
// [点1·分词 + 点2·词分类] 把用户原文切成词, 剔虚词/填充, 留实义词(含 OOV 专名/罕见单字)
//   资源: jieba-wasm(HMM) 为主; runStep1Extract(BCC 贪心最长匹配) 为 fallback.
//   分类: classifyWord(停用词∪标点 → drop; 其余 content). POS/BCC 频率已从分类删除.
// ════════════════════════════════════════════════════════════════════
export function _extractQueryWords(text, roleSink = null, nounOnly = false) {
  if (!text || !text.trim()) return [];
  // nounOnly(实验): 用 jieba POS 标注, 动词/副词当噪音(切断 SWOW 误召源), 名词/单字/非记录词留.
  const tagged = (nounOnly && _jiebaTag) ? _jiebaTag(text, true) : null;
  const tokens = tagged ? tagged.map((t) => t.word) : (_jiebaCut ? _jiebaCut(text, true) : (runStep1Extract(text).words || []));
  const tagOf = tagged ? new Map(tagged.map((t) => [t.word, t.tag])) : null;
  const out = [], seen = new Set();
  for (const w of tokens) {
    if (seen.has(w)) continue;
    const role = classifyWord(w);
    if (roleSink) roleSink.push({ w, role, tag: tagOf ? tagOf.get(w) : undefined });
    if (role === "drop") continue; // 虚词/停用/填充词不进召回; 留 content + proper.
    if (nounOnly && tagOf && !_isNounish(w, tagOf.get(w))) continue; // 实验: 动词/副词噪音剔除
    seen.add(w);
    out.push(w);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
// expandQuery — 输入文本 → 召回匹配键集(点1/3/4/5/6)
//   opts: { chatHistory, aliasMap, swowTopK, ctxSentCount, nounDiv, nounOnly, _trace }
//   返回 { baseWords0, baseWords, divMap, divergedWords, ctxWords }
// ════════════════════════════════════════════════════════════════════
export function expandQuery(inputText, opts = {}) {
  const swowTopK = opts.swowTopK ?? 4;
  const ctxSentCount = opts.ctxSentCount ?? 6;
  const _nounDiv = (opts.nounDiv !== false); // 方向2: SWOW 发散只对名词性 baseWords(动词不发散), 默认 ON
  const _nounOnly = !!opts.nounOnly;
  const aliasMap = opts.aliasMap ?? {};
  const _pv = opts.packVocab || null; // 词库热插拔: {synonyms, diverge, stopwords} 包补充(为空则各步无影响)
  const _typingActive = opts.typingActive instanceof Set ? opts.typingActive : null; // 打字式三层激活热词集(为空则无影响)
  const _tr = opts._trace || null; // 白盒插桩: 捕获扩词阶段内部状态
  const _roleSink = _tr ? [] : null;

  // ── [点1·分词(jieba 为主)] ── (词库包 stopwords: 域内停用词从查询键剔除)
  let baseWords0 = _extractQueryWords(inputText, _roleSink, _nounOnly);
  // ── [点1b·词库辅助·额外提取] jieba 切完, 另把原文里的词库词当补充键并入(加法, 不改 jieba token) ──
  const _packSet = _pv ? _buildPackWordSet(_pv) : null;
  if (_packSet) {
    const extra = _extractPackWords(inputText, _packSet).filter((w) => !baseWords0.includes(w));
    if (extra.length) baseWords0 = [...baseWords0, ...extra];
    if (_tr) _tr.point1b_packExtra = extra;
  }
  // ── [点1c·打字式激活热词·额外提取] 三层激活(频率2+时间+系统保存)过关的用户常用词, 原文里出现则并入(加法) ──
  if (_typingActive && _typingActive.size) {
    const extraT = _extractPackWords(inputText, _typingActive).filter((w) => !baseWords0.includes(w));
    if (extraT.length) baseWords0 = [...baseWords0, ...extraT];
    if (_tr) _tr.point1c_typingExtra = extraT;
  }
  if (_pv && _pv.stopwords && _pv.stopwords.size) baseWords0 = baseWords0.filter((w) => !_pv.stopwords.has(w));
  if (_tr) { _tr.classify = _roleSink; _tr.point1_baseWords0 = [...baseWords0]; }

  // ── [点6·上下文词] 当前输入无内容词时, 用最近对话主题驱动召回. 最近 6 句(CTX_SENT_COUNT). strength=0 仅粗筛. ──
  const ctxMsgs = Array.isArray(opts.chatHistory) ? opts.chatHistory.slice(-ctxSentCount) : [];
  const ctxWordsAll = [];
  for (const msg of ctxMsgs) {
    const c = typeof msg === "string" ? msg : (msg?.content || "");
    for (const w of _extractQueryWords(c, null, _nounOnly)) ctxWordsAll.push(w);
    if (_packSet) for (const w of _extractPackWords(c, _packSet)) ctxWordsAll.push(w);
    if (_typingActive && _typingActive.size) for (const w of _extractPackWords(c, _typingActive)) ctxWordsAll.push(w);
  }
  const ctxWords = [...new Set(ctxWordsAll)];

  // ── [点3·别名扩展] 变体也搜(贝露↔贝露赛因、焰↔晓美焰). 自动库 PMI-IR + 子串; 深度库 P9 LLM 离线. ──
  const aliasWords = expandWithAliases(baseWords0, aliasMap, inputText);
  const baseWords = [...new Set([...baseWords0, ...aliasWords])];
  const baseSet = new Set(baseWords);
  if (_tr) { _tr.point3_aliasWords = [...aliasWords]; _tr.point3_baseWords = [...baseWords]; _tr.point6_ctxWords = [...ctxWords]; }

  // ── [点4·SWOW发散 + 点5·同义词林] 发散匹配键: 原词权 1.0 > 发散词权 = swow strength; 同义/上下文词 strength=0 ──
  const divMap = new Map();
  for (const w of baseWords) {
    if (!_nounDiv || _isNounish(w)) {       // 方向2: 仅名词性词发散(动词不发散成抽象名词→切"明白→理解"误召源); 动词仍走字面匹配
      for (const s of swowDiverge(w, swowTopK)) {
        if (s.word && !baseSet.has(s.word)) {
          divMap.set(s.word, Math.max(divMap.get(s.word) || 0, s.strength || 0));
        }
      }
      if (_pv && _pv.diverge && _pv.diverge[w]) { // 词库包发散补充(资源自带 strength), 与 SWOW 同口径取强
        for (const it of _pv.diverge[w]) if (it.word && !baseSet.has(it.word)) divMap.set(it.word, Math.max(divMap.get(it.word) || 0, +it.strength || 0));
      }
    }
    for (const sw of synonymsOf(w)) {       // 内化哈工大同义词林(Cilin): 补字面变体, 粗筛捞候选(strength 0)
      if (!baseSet.has(sw) && !divMap.has(sw)) divMap.set(sw, 0);
    }
    if (_pv && _pv.synonyms && _pv.synonyms[w]) { // 词库包同义补充(strength 0, 同 Cilin)
      for (const sw of _pv.synonyms[w]) if (!baseSet.has(sw) && !divMap.has(sw)) divMap.set(sw, 0);
    }
  }
  // 上下文词进次级匹配键(粗筛用): 当前对话主题也参与找候选. 召回不主导. strength 0.
  for (const w of ctxWords) if (!baseSet.has(w) && !divMap.has(w)) divMap.set(w, 0);
  const divergedWords = [...divMap.keys()];
  if (_tr) _tr.divMap = Object.fromEntries(divMap);

  return { baseWords0, baseWords, divMap, divergedWords, ctxWords };
}
