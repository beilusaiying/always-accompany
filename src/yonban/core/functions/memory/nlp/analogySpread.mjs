/**
 * analogySpread.mjs — 路径 B 类比发散（词林 distance=4 跨大类，非同义扩展）
 *
 * 功能链：p1_node2_swow / queryExpand → analogySpread(word, opts) → [{word, distance, code}]（类比候选词）
 * why：SWOW 发散覆盖日常联想，类比发散补跨大类关联（distance=4，非 distance=1 同义）；
 *      词林 8字符编码结构决定距离层级，distance=4 = 同大类不同中类 = 真正类比而非同义。
 * 关联链：
 *   ← p1_node2_swow.mjs（路径B 类比发散，拦 distance=1 死红线后走本模块）
 *   ← queryExpand.mjs（点4 SWOW 发散时补 analogySpread 候选）
 *   → lib/nlp/cilin.json（哈工大同义词林扩展版，进程级懒加载）
 * 影响范围：只读 cilin.json（进程级 Map 缓存，缺失不崩返回空数组）
 */
 *
 * 编码格式: "Aa01A01=" (8字符)
 *   位 0:     大类 A-L
 *   位 0-1:   中类 Aa-Lz
 *   位 0-3:   小类 Aa01-...
 *   位 0-4:   词群 Aa01A-...
 *   位 0-7:   原子词群 Aa01A01=
 *
 * 距离映射(以 codeDistance() 实际断点为准, 均为 ≥ 阈值):
 *   共同前缀 ≥8 → distance=0  同原子词群(同义词)
 *   共同前缀 ≥7 → distance=1  同词群
 *   共同前缀 ≥5 → distance=2  同小类
 *   共同前缀 ≥3 → distance=3  同中类
 *   共同前缀 ≥1 → distance=4  同大类(跨中类 = 类比)
 *   共同前缀  0  → distance=5  完全无关(跨大类)
 *
 * 任务文档原文: distance=4 跨大类(类比), distance=5 完全无关
 * → distanceMin=4 默认匹配"共同首字母不同大类以外的同大类"
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ====== 加载词林数据(一次性) ======

const CILIN_PATH = join(__dirname, "..", "cilin.json");
let _cilin = null;
let _cilinIdx = null;

export function getCilin() {
  if (_cilin) return _cilin;
  const raw = fs.readFileSync(CILIN_PATH, "utf-8");
  _cilin = JSON.parse(raw);
  return _cilin;
}

// 倒排索引(2026-04-26 P99 优化): 按大类首字母分桶
// 17K codes → 12 桶, 每桶 ~1500 codes(distance=4 必在同桶)
function getCilinIndex() {
  if (_cilinIdx) return _cilinIdx;
  const cilin = getCilin();
  const byBigClass = {};
  const allCodesArr = [];
  for (const code of Object.keys(cilin.code2words)) {
    const bc = code[0];
    (byBigClass[bc] ||= []).push(code);
    allCodesArr.push(code);
  }
  _cilinIdx = { byBigClass, allCodes: allCodesArr };
  return _cilinIdx;
}

// per-word LRU cache(同词反复调用直接命中)
const _analogyCache = new Map();
const ANALOGY_CACHE_MAX = 5000;

// ====== 编码距离计算 ======

/**
 * 计算两个词林编码之间的语义距离
 * 编码格式示例: "Aa01A01=" (8字符)
 *
 * 层级断点(按任务文档):
 *   共同前缀 ≥8 → 0 (同原子词群)
 *   共同前缀  7  → 1 (同词群)
 *   共同前缀 ≥5  → 2 (同小类)
 *   共同前缀 ≥3  → 3 (同中类)
 *   共同前缀 ≥1  → 4 (同大类,类比区)
 *   共同前缀  0  → 5 (完全无关)
 */
export function codeDistance(codeA, codeB) {
  if (codeA === codeB) return 0;
  const len = Math.min(codeA.length, codeB.length);
  let commonLen = 0;
  for (let i = 0; i < len; i++) {
    if (codeA[i] === codeB[i]) commonLen++;
    else break;
  }
  if (commonLen >= 8) return 0;
  if (commonLen >= 7) return 1;
  if (commonLen >= 5) return 2;
  if (commonLen >= 3) return 3;
  if (commonLen >= 1) return 4;
  return 5;
}

// ====== 主函数: 类比扩散 ======

/**
 * analogyExpand(word, options)
 *
 * 策略: 先收集所有满足距离条件的目标 code 列表,
 * 按 targetCode 前缀分组(每个大类采一个),再均匀采样 topK 词
 * 避免全部命中同一个大类(Aa)
 *
 * @param {string} word - 输入词
 * @param {object} options
 *   - distanceMin {number} 默认 4
 *   - distanceMax {number} 默认 5
 *   - topK {number} 默认 5
 * @returns {Array<{word, sourceCode, targetCode, distance}>}
 */
export function analogyExpand(word, options = {}) {
  const distanceMin = options.distanceMin ?? 4;
  const distanceMax = options.distanceMax ?? 5;
  const topK = options.topK ?? 5;

  // LRU cache(同词同参数直接命中)
  const cacheKey = `${word}|${distanceMin}|${distanceMax}|${topK}`;
  const cached = _analogyCache.get(cacheKey);
  if (cached) {
    _analogyCache.delete(cacheKey);
    _analogyCache.set(cacheKey, cached);
    return cached;
  }

  const cilin = getCilin();
  const sourceCodes = cilin.word2codes[word];
  if (!sourceCodes || sourceCodes.length === 0) return [];

  // 收集所有满足距离条件的 (sourceCode, targetCode, dist) 对
  // 按目标大类分桶(targetCode[0] = 大类字母),每桶取前 2 个 code
  // 这样可以跨大类均匀采样,防止全部落入 Aa 类
  // 倒排索引优化(2026-04-26): distance=4 必在同大类桶, distance=5 必在不同大类
  const idx = getCilinIndex();
  const buckets = {}; // bigClass → [{sourceCode, targetCode, dist}, ...]

  for (const sourceCode of sourceCodes) {
    const sBigClass = sourceCode[0];
    // distance=4 区间: 必在同大类桶
    // distance=5 区间: 跨大类(其他桶), 数量大也得扫
    let candidatePool;
    if (distanceMin >= 4 && distanceMax <= 4) {
      candidatePool = idx.byBigClass[sBigClass] || [];
    } else if (distanceMin >= 5) {
      candidatePool = idx.allCodes.filter(c => c[0] !== sBigClass);
    } else {
      candidatePool = idx.allCodes;
    }
    for (const targetCode of candidatePool) {
      if (targetCode === sourceCode) continue;
      const dist = codeDistance(sourceCode, targetCode);
      if (dist < distanceMin || dist > distanceMax) continue;

      const bigClass = targetCode[0];
      if (!buckets[bigClass]) buckets[bigClass] = [];
      if (buckets[bigClass].length < 2) {
        buckets[bigClass].push({ sourceCode, targetCode, dist });
      }
    }
  }

  // 从每个桶里取 1 个词(首词),然后 round-robin 凑满 topK
  const results = [];
  const seenWords = new Set([word]);
  const bigClasses = Object.keys(buckets).sort(); // 字母序稳定

  let round = 0;
  while (results.length < topK) {
    let added = false;
    for (const bc of bigClasses) {
      if (results.length >= topK) break;
      const entries = buckets[bc];
      if (!entries || entries.length === 0) continue;
      // 每轮从该桶的 entries[round % entries.length] 取词
      const entry = entries[round % entries.length];
      const words = cilin.code2words[entry.targetCode] || [];
      // 找一个未见过的词
      const picked = words.find(w => !seenWords.has(w));
      if (picked) {
        seenWords.add(picked);
        results.push({
          word: picked,
          sourceCode: entry.sourceCode,
          targetCode: entry.targetCode,
          distance: entry.dist,
        });
        added = true;
      }
    }
    round++;
    if (!added) break; // 所有桶都耗尽
    if (round > 10) break; // 安全截断
  }

  const finalResults = results.slice(0, topK);
  _analogyCache.set(cacheKey, finalResults);
  if (_analogyCache.size > ANALOGY_CACHE_MAX) {
    _analogyCache.delete(_analogyCache.keys().next().value);
  }
  return finalResults;
}
