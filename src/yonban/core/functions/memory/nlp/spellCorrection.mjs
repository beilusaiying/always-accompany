/**
 * spellCorrection.mjs — H1 错别字系统层（单向词典 + 英文功能词白名单 + edit-distance 候选过滤）
 *
 * 功能链：当前无调用方（真实导出为 correctSpelling(text, lang) / correctSpellingBatch(texts, lang) / preloadDicts() / getFunctionWordCount()；
 *         全仓 grep 未发现任何文件 import 本模块，queryExpand.mjs 等 nlp/ 同目录文件均未引用）
 * why：用户输错字导致分词后词不在词库（"做梦"误打"做夢"）；单向纠错（低频→高频）防循环互换；
 *      英文功能词白名单（with/the/a）确保常见词绝不被纠错扰乱。
 * 关联链：
 *   ← queryExpand.mjs（jieba 分词后、别名扩展前调用纠错）
 *   → lib/nlp/spell_zh.json（中文错别字词典，单向低→高频）
 *   → lib/nlp/spell_en.json（英文拼写词典）
 * 影响范围：只读词典文件（_enMap/_zhMap，进程级懒加载）；纯查表无副作用
 *
 * 修复清单 (lab #2 发现):
 *   Fix 1: 中文字典改单向 (低频→高频, 不再双向互换)
 *   Fix 2: 英文功能词白名单 (with/the/a/an 等绝不纠错)
 *   Fix 3: edit-distance scan 加候选词过滤 (候选词本身在白名单则跳过)
 *
 * 凛倾铁律: 不用暴力硬匹配; 白名单用置信度过滤; 单向=高频词不被改
 *
 * @module spellCorrection
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// 加载字典
// ============================================================

const _moduleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // nlp/ → lib/ (JSON 数据在 lib/ 根)

let _enMap = null;   // Map<wrong, correct>
let _zhMap = null;   // Map<wrong, correct>

// ============================================================
// Fix 2: 英文功能词白名单
// 来源: NLTK stopwords + spaCy en_core_web 功能词 + 高频正确词
// 这些词绝不参与纠错 (无论直接命中还是 edit distance 扫描)
// ============================================================
const EN_FUNCTION_WORDS = new Set([
  // 冠词
  "a", "an", "the",
  // 介词
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about",
  "into", "through", "during", "before", "after", "above", "below", "between",
  "out", "off", "over", "under", "again", "then", "once", "over",
  // 连词
  "and", "or", "but", "nor", "so", "yet", "for", "both", "either", "neither",
  "if", "unless", "until", "while", "because", "since", "though", "although",
  "whether", "when", "where", "that", "which", "who", "whom", "whose",
  // 代词
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself",
  "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
  "what", "which", "who", "whom", "this", "that", "these", "those",
  // 助动词/系动词
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having",
  "do", "does", "did", "doing",
  "will", "would", "could", "should", "shall", "may", "might", "must",
  "can", "need", "dare", "ought", "used",
  // 否定/副词
  "not", "no", "nor", "never", "always", "often", "usually", "sometimes",
  "here", "there", "now", "just", "also", "too", "very", "quite", "more",
  "most", "much", "many", "some", "any", "all", "few", "little", "other",
  "such", "own", "same", "than", "as",
  // 常见动词 (短词, 容易被 edit distance 误命中)
  "get", "got", "set", "let", "put", "cut", "run", "ran", "say", "said",
  "see", "saw", "come", "came", "go", "went", "take", "took", "make", "made",
  "know", "knew", "think", "thought", "look", "use", "find", "give", "tell",
  "work", "call", "try", "ask", "need", "feel", "become", "leave", "show",
  "keep", "hand", "start", "turn", "live", "play", "move", "like", "want",
  "seem", "help", "talk", "back", "mean", "real", "open", "read", "walk",
  // 常见正确词 (被 edit distance 误命中的高频词)
  "with", "will", "well", "were", "when", "then", "than",
  "have", "give", "live", "love", "like", "line", "time", "tile",
  "your", "four", "our", "hour", "out", "but", "bit",
  "from", "form", "firm", "film",
  "now", "how", "who", "two", "too", "top",
  "file", "fill", "fall", "tall", "call", "ball", "hall", "wall",
  "list", "last", "last", "fast", "past",
  "next", "text", "test", "best",
  "each", "such", "much", "rich",
  "can", "run", "fun", "sun", "gun",
  "end", "and", "any", "man",
  "had", "has", "hat", "ham", "bad", "bag",
  "also", "able", "about", "above", "after", "again", "against",
]);

// ============================================================
// Fix 1: 中文单向字典修正说明
// 原则: 低频错字 → 高频正字 (单向)
// 判断依据: 现代汉语词频统计 + 语义区分
//
// 修正方向:
//   侯选人 → 候选人 (侯=封建侯爵, 候=等待/候选, 候选更高频)
//   辩论 → 辩论 (保留), 辨别 → 辨别 (保留)
//   辨论 → 辩论 (辨+论=误用, 辩论是正确词), 辩别 → 辨别 (辩+别=误用)
//   那 → 哪 (疑问语境单向, 但上下文判断复杂; 暂保留单向: 哪→那 去掉)
//   厉 → 历 (厉害/厉行不能改; 只有"厉"作"历"误用时才改; 暂不双向)
//   熟习 → 熟悉 (熟悉更常见, 熟习是书面语, 单向: 熟习→熟悉)
// ============================================================

// 单向中文字典 (比原始 JSON 更精确, 在代码中直接构造)
const ZH_UNIDIRECTIONAL_PAIRS = [
  // 候/侯: 侯(侯爵)被误用为候(候选) → 改回候
  // "侯选" 是明显错误，"候选" 才是正确用法
  { from: "侯选", to: "候选", type: "bigram", note: "侯选→候选(单向)" },
  // 辩/辨: 单字无法确定方向，改用二字组合判断
  // "辩别" = 误用 → "辨别"
  { from: "辩别", to: "辨别", type: "bigram", note: "辩别→辨别(单向)" },
  // "辨论" = 误用 → "辩论"
  { from: "辨论", to: "辩论", type: "bigram", note: "辨论→辩论(单向)" },
  // 那/哪: 只在明确疑问句中，哪→那 去掉 (单字方向无法可靠判断，暂不加单字对)
  // 厉/历: 单字对太危险，暂不加 (厉害、厉行是正确用法)
  // 熟习→熟悉 (书面→口语，单向)
  { from: "熟习", to: "熟悉", type: "word", note: "熟习→熟悉(单向)" },
  // 保留确定的单字高置信度对 (候/侯 在非组合语境)
  // 注: 单字对只在二字组合 bigram 中用, 避免误报
];

function _loadDicts() {
  if (_enMap && _zhMap) return;

  // 英文 typo pairs
  _enMap = new Map();
  try {
    const enPath = path.join(_moduleDir, "typo_pairs_en.json");
    if (fs.existsSync(enPath)) {
      const raw = JSON.parse(fs.readFileSync(enPath, "utf-8"));
      for (const item of raw) {
        // Fix 2: 跳过 from/to 在功能词白名单中的条目
        const fromLower = (item.from || "").toLowerCase();
        const toLower = (item.to || "").toLowerCase();
        if (EN_FUNCTION_WORDS.has(fromLower) || EN_FUNCTION_WORDS.has(toLower)) {
          continue; // 功能词不进纠错字典
        }
        if ((item.freq || 1) >= 2 && !_enMap.has(fromLower)) {
          _enMap.set(fromLower, item.to);
        }
      }
    }
  } catch { /* skip */ }

  // 中文 typo pairs — Fix 1: 使用单向字典代替双向 JSON
  _zhMap = new Map();
  // 从内置单向对构建 (优先级高于 JSON)
  for (const pair of ZH_UNIDIRECTIONAL_PAIRS) {
    if (!_zhMap.has(pair.from)) {
      _zhMap.set(pair.from, { to: pair.to, type: pair.type });
    }
  }
  // 也尝试加载 typo_pairs_zh.json，但只用 type=word 且非双向对的条目
  // (单字对必须有明确上下文支持才能用)
  try {
    const zhPath = path.join(_moduleDir, "typo_pairs_zh.json");
    if (fs.existsSync(zhPath)) {
      const raw = JSON.parse(fs.readFileSync(zhPath, "utf-8"));
      // 建立反向查找表: 找双向对
      const reverseMap = new Map();
      for (const item of raw) {
        reverseMap.set(item.from, item.to);
      }
      for (const item of raw) {
        // 如果 to→from 也在字典里，这是双向对，跳过 (Fix 1)
        const isSymmetric = reverseMap.has(item.to) && reverseMap.get(item.to) === item.from;
        if (isSymmetric) {
          // 双向对: 跳过原始 JSON (已经在 ZH_UNIDIRECTIONAL_PAIRS 中用更精确的双字形式处理)
          continue;
        }
        // 单向对 (JSON 里本来就是单向): 加入
        if (!_zhMap.has(item.from)) {
          _zhMap.set(item.from, { to: item.to, type: item.type || "word" });
        }
      }
    }
  } catch { /* skip */ }
}

// ============================================================
// Edit Distance (Levenshtein)
// ============================================================

function editDistance(s1, s2) {
  const m = s1.length, n = s2.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = s1[i - 1] === s2[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// ============================================================
// 英文纠错
// ============================================================

/**
 * Fix 2+3: 加功能词白名单 + edit distance scan 也检查白名单
 * @param {string} token - 小写单词
 * @returns {string|null}
 */
function _correctEnToken(token) {
  _loadDicts();

  // Fix 2: 功能词直接跳过
  if (EN_FUNCTION_WORDS.has(token)) return null;

  // 1. 直接命中字典
  if (_enMap.has(token)) return _enMap.get(token);

  // 2. edit distance ≤ 1 scan
  // Fix 3: 候选词 (wrong side) 也不能在白名单里 — 防止正常词被 edit-dist 误命中
  if (token.length >= 4 && token.length <= 15) {
    let bestDist = 2;
    let bestCandidate = null;
    for (const [wrong, correct] of _enMap) {
      if (wrong === token) continue;
      // Fix 3: 如果 token 和 wrong 都不在白名单才扫 (correct 侧无需检查，字典已过滤)
      // 额外保护: 如果 token 与白名单中的词 edit distance ≤ 1，不纠错
      // (token 可能本身是合法词，只是拼写近似 wrong)
      const d = editDistance(token, wrong);
      if (d <= 1 && d < bestDist) {
        // 软匹配置信度: 要求 token 不近似任何白名单词
        // 如果 token 与某个功能词 edit distance = 0 (完全相同)已由上面处理
        // 这里检查: token 本身是否是白名单词的 1-edit 邻居 → 若是，置信度低，跳过
        let tooCloseToFunctionWord = false;
        for (const fw of EN_FUNCTION_WORDS) {
          if (fw.length >= 3 && editDistance(token, fw) <= 1) {
            tooCloseToFunctionWord = true;
            break;
          }
        }
        if (!tooCloseToFunctionWord) {
          bestDist = d;
          bestCandidate = correct;
        }
      }
    }
    if (bestCandidate) return bestCandidate;
  }
  return null;
}

// ============================================================
// 中文纠错 — Fix 1: 使用单向字典, 优先双字组合
// ============================================================

/**
 * Fix 1: 先做二字组合扫描 (bigram), 再做单字扫描
 * 二字组合优先级更高，可以区分候选/辩论/辨别等
 * @param {string} text
 * @returns {Array<{from:string, to:string, position:number}>}
 */
function _correctZh(text) {
  _loadDicts();
  const corrections = [];
  const usedPositions = new Set(); // 已处理位置, 防止单字再覆盖

  // Two-char window (优先, Fix 1: 双字比单字精确)
  for (let i = 0; i < text.length - 1; i++) {
    const bigram = text.slice(i, i + 2);
    if (_zhMap.has(bigram)) {
      const entry = _zhMap.get(bigram);
      corrections.push({ from: bigram, to: entry.to, position: i });
      usedPositions.add(i);
      usedPositions.add(i + 1);
    }
  }

  // Single-char window (只处理未被双字窗口覆盖的位置)
  for (let i = 0; i < text.length; i++) {
    if (usedPositions.has(i)) continue;
    const ch = text[i];
    if (_zhMap.has(ch)) {
      const entry = _zhMap.get(ch);
      // 基础安全词跳过 (高频功能词不改)
      const SAFE_SKIP = new Set(["的", "了", "在", "是", "不", "和", "也", "都"]);
      if (!SAFE_SKIP.has(ch)) {
        corrections.push({ from: ch, to: entry.to, position: i });
      }
    }
  }

  return corrections;
}

// ============================================================
// 主接口
// ============================================================

/**
 * @param {string} text
 * @param {'zh'|'en'|'auto'} [lang='auto']
 * @returns {{ corrected: string, corrections: Array<{from:string, to:string, position:number}> }}
 */
export function correctSpelling(text, lang = "auto") {
  if (!text || typeof text !== "string") {
    return { corrected: text, corrections: [] };
  }

  if (lang === "auto") {
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    lang = cjkCount > text.length * 0.3 ? "zh" : "en";
  }

  const corrections = [];
  let corrected = text;

  if (lang === "zh") {
    const candidates = _correctZh(text);
    const applied = new Set();
    for (const c of candidates) {
      if (applied.has(c.position)) continue;
      applied.add(c.position);
      corrections.push(c);
    }
    for (const c of [...corrections].sort((a, b) => b.position - a.position)) {
      corrected = corrected.slice(0, c.position) + c.to + corrected.slice(c.position + c.from.length);
    }
  } else {
    const tokenRegex = /([a-zA-Z]+)/g;
    let match;
    const replacements = [];
    while ((match = tokenRegex.exec(text)) !== null) {
      const original = match[1];
      const lower = original.toLowerCase();
      if (lower.length < 3) continue;
      const fixed = _correctEnToken(lower);
      if (fixed && fixed !== lower) {
        const restored = original[0] === original[0].toUpperCase()
          ? fixed[0].toUpperCase() + fixed.slice(1)
          : fixed;
        replacements.push({ from: original, to: restored, position: match.index });
      }
    }
    for (const r of replacements.sort((a, b) => b.position - a.position)) {
      corrected = corrected.slice(0, r.position) + r.to + corrected.slice(r.position + r.from.length);
      corrections.push(r);
    }
    corrections.sort((a, b) => a.position - b.position);
  }

  return { corrected, corrections };
}

/**
 * 批量纠错
 */
export function correctSpellingBatch(texts, lang = "auto") {
  return texts.map(t => ({ original: t, ...correctSpelling(t, lang) }));
}

/**
 * 预加载字典
 */
export function preloadDicts() {
  _loadDicts();
  return {
    enPairs: _enMap ? _enMap.size : 0,
    zhPairs: _zhMap ? _zhMap.size : 0,
  };
}

/**
 * 调试: 返回功能词白名单大小
 */
export function getFunctionWordCount() {
  return EN_FUNCTION_WORDS.size;
}
