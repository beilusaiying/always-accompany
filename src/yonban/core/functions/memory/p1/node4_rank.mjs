// node4_rank.mjs — 混合排序: 倒排索引 + BM25 + 关联词命中 + 短语匹配
//
// 设计来源: P1_新管线设计_算法标注版.md §混合排序
// 架构: 文档集半静态(三层记忆) → 建倒排索引(一次) → 查询词 O(1) 查索引 → 候选集 → BM25+hits+phrase 排序
// 链: 发散产出 → Gigatoken(LLM分词第二视角) → 去重 → 索引查询 → BM25+hits+phrase → 综合排序

import { httpCall } from './cluster.mjs';
import { nbPairwiseBatch } from './node3_score.mjs';
import { bridgeTokenize } from './node1_tokenize.mjs';
import { createHash } from 'node:crypto';

const envF = (n, d) => { const v = parseFloat(process.env[n]); return Number.isFinite(v) ? v : d; };

const envI = (n, d) => { const v = parseInt(process.env[n], 10); return Number.isFinite(v) ? v : d; };
const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const PARAMS = {
  BM25_K1: 1.2,
  BM25_B: 0.75,
  HIT_WEIGHT: envF('P1_HIT_WEIGHT', 0.5),
  PHRASE_WEIGHT: envF('P1_PHRASE_WEIGHT', 0.3),
  PHRASE_MIN_RUN: 3,
  // NB 近义去重: cosine(w1,w2) 超过阈值才视为近义；框架默认0.85，[待实验定]可配置。
  NB_DEDUP_THRESH: Math.min(1, Math.max(0, envF('P1_NB_DEDUP_THRESH', 0.85))),
  RRF_K: 60,
  TOP_INPUT_BONUS: 0.2,
  OOV_BONUS: envF('P1_OOV_BONUS', 0.5),
  // 三条独立排序信号：精确锚点、查询时间、记录自身重要性。都可由 config_map 覆盖。
  EXACT_ANCHOR_BONUS: envF('P1_EXACT_ANCHOR_BONUS', 0.75),
  TIME_MATCH_BONUS: envF('P1_TIME_MATCH_BONUS', 0.8),
  RECORD_TOP_BONUS: envF('P1_RECORD_TOP_BONUS', 1.0),
  RECORD_IMPORTANCE_WEIGHT: envF('P1_RECORD_IMPORTANCE_WEIGHT', 0.5),
  // anchor 词取 scored pool 前 N 个(控制匹配查询宽度) [待实验定: 经验起步值]
  ANCHOR_TOPN: clampI(envI('P1_ANCHOR_TOPN', 30), 5, 100),
  // "top也是加分项": 从去重后发散池取前 N 个作为 top 加分候选 [待实验定: 经验起步值]
  TOP_BONUS_N: clampI(envI('P1_TOP_BONUS_N', 10), 1, 50),
  // 短输入宽松召回: 输入 < SHORT_INPUT_CHARS 字时 minHits 固定为 1(不按文档长度计算)
  SHORT_INPUT_CHARS: 12,
  // 文档候选门槛除数: minHits = ceil(docLen / HITS_DIVISOR); 默认 10=每 10 字需 1 命中
  HITS_DIVISOR: 10,
};

// ---- 倒排索引(按角色 memory scope+mode 隔离，storage 版本失效；直调走全文哈希) ----
// 仅缓存 docs→posting 的纯只读索引；chatId/window 请求态、候选集和最终排名均不缓存。
const _idxCache = new Map();
// _idxCache 是进程级共享 owner；请求值只能在此硬上限内调小，不能由单个用户抬高全服务容量。
const INDEX_CACHE_HARD_CAP = clampI(envI('P1_INDEX_CACHE_HARD_CAP', 8), 1, 64);

function _contentVersion(docs) {
  const hash = createHash('sha256');
  hash.update(`${docs.length}\0`);
  for (const doc of docs) {
    const text = String(doc?.text ?? '');
    hash.update(`${Buffer.byteLength(text, 'utf8')}:`);
    hash.update(text);
    hash.update(JSON.stringify({
      metadataTerms: doc?.metadataTerms ?? [],
      keywords: doc?.keywords ?? [], tags: doc?.tags ?? [],
      ts: doc?.ts ?? null, fileTs: doc?.fileTs ?? null,
      fileCreatedTime: doc?.fileCreatedTime ?? null,
      weight: doc?.weight ?? null, importance: doc?.importance ?? null,
      top: doc?.top ?? false, pinned: doc?.pinned ?? false,
    }));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function _indexLimits(value) {
  const n = Number(value);
  const requested = Number.isFinite(n) ? Math.max(0, Math.min(64, Math.trunc(n))) : 8;
  const hardCap = INDEX_CACHE_HARD_CAP;
  return { requested, effective: Math.min(requested, hardCap), hardCap };
}

function _trimIndexCache(limit) {
  let evictions = 0;
  while (_idxCache.size > limit) {
    const oldest = _idxCache.keys().next().value;
    _idxCache.delete(oldest);
    evictions++;
  }
  return evictions;
}

function buildIndex(docs, { scopeKey, version, maxEntries } = {}) {
  const key = String(scopeKey || 'direct');
  const versionSource = version ? 'storage' : 'content';
  const versionKey = String(version || _contentVersion(docs));
  const limits = _indexLimits(maxEntries);
  const limit = limits.effective;
  // effective=0 是禁用缓存，不读取旧项作为命中；下面只为当前排序构建瞬时 idx。
  const cached = limit > 0 ? _idxCache.get(key) : undefined;
  if (cached && cached.version === versionKey) {
    // 先把本次命中项提升为 MRU，再按当前 effective 上限裁剪；收紧时不能误删当前项。
    if (limit > 0) {
      _idxCache.delete(key);
      _idxCache.set(key, cached);
    }
    const evictions = _trimIndexCache(limit);
    return {
      idx: cached.idx,
      cache: {
        hit: true, rebuilt: false, enabled: limit > 0, docCount: docs.length,
        version: versionKey.slice(0, 12), versionSource,
        ...limits, entries: _idxCache.size, evictions,
      },
    };
  }

  // miss 也先应用当前全局上限；尤其 effective=0 时必须清掉此前由其他请求留下的索引。
  let evictions = _trimIndexCache(limit);

  const posting = new Map();
  const metadataPosting = new Map();
  for (let i = 0; i < docs.length; i++) {
    const t = String(docs[i].text ?? '');
    for (let j = 0; j < t.length; j++) {
      const ch = t[j];
      if (!posting.has(ch)) posting.set(ch, new Set());
      posting.get(ch).add(i);
      if (j + 1 < t.length) {
        const bg = ch + t[j + 1];
        if (!posting.has(bg)) posting.set(bg, new Set());
        posting.get(bg).add(i);
      }
    }
    const metadataTerms = [...new Set([
      ...(Array.isArray(docs[i].metadataTerms) ? docs[i].metadataTerms : []),
      ...(Array.isArray(docs[i].keywords) ? docs[i].keywords : []),
      ...(Array.isArray(docs[i].tags) ? docs[i].tags : []),
    ].map(v => String(v ?? '').trim().toLocaleLowerCase()).filter(Boolean))];
    for (const term of metadataTerms) {
      if (!metadataPosting.has(term)) metadataPosting.set(term, new Set());
      metadataPosting.get(term).add(i);
    }
  }
  const idx = { posting, metadataPosting, size: docs.length };
  if (limit > 0) {
    _idxCache.delete(key);
    _idxCache.set(key, { version: versionKey, idx });
  }
  evictions += _trimIndexCache(limit);
  return {
    idx,
    cache: {
      // disabled 时仍为当前请求重建瞬时 idx，但不会命中或插入 owner Map。
      hit: false, rebuilt: true, enabled: limit > 0, docCount: docs.length,
      version: versionKey.slice(0, 12), versionSource,
      ...limits, entries: _idxCache.size, evictions,
    },
  };
}

function queryIndex(idx, term, docs) {
  if (!term) return new Set();
  if (term.length === 1) return idx.posting.get(term) ?? new Set();
  // 取所有 bigram 的交集(必要条件),再 includes 精确验证
  let cands = null;
  for (let j = 0; j + 1 < term.length; j++) {
    const bg = term[j] + term[j + 1];
    const p = idx.posting.get(bg);
    if (!p || !p.size) return new Set();
    if (!cands) { cands = new Set(p); }
    else { for (const d of cands) if (!p.has(d)) cands.delete(d); }
    if (!cands.size) return cands;
  }
  const out = new Set();
  for (const d of cands) if (docs[d].text.includes(term)) out.add(d);
  return out;
}

function queryMetadataExact(idx, term) {
  const key = String(term ?? '').trim().toLocaleLowerCase();
  return key ? (idx.metadataPosting.get(key) ?? new Set()) : new Set();
}

function _isWordChar(ch) {
  return Boolean(ch) && /[\p{L}\p{N}_]/u.test(ch);
}

function _bodyHasExactAnchor(text, anchor) {
  const source = String(text ?? '');
  const raw = String(anchor ?? '').trim();
  if (!raw) return false;
  if (/[^\x00-\x7F]/.test(raw)) return source.includes(raw);
  const haystack = source.toLocaleLowerCase();
  const needle = raw.toLocaleLowerCase();
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at > 0 ? haystack[at - 1] : '';
    const after = at + needle.length < haystack.length ? haystack[at + needle.length] : '';
    if (!_isWordChar(before) && !_isWordChar(after)) return true;
    from = at + Math.max(1, needle.length);
  }
  return false;
}

function _clamp01(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function _localParts(ms) {
  const d = new Date(ms);
  return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate() };
}

function _startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function _timeAnchorMatch(anchor, docMs, referenceTimeMs) {
  const normalized = String(anchor?.normalized ?? '');
  const p = _localParts(docMs);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const [y, m, day] = normalized.split('-').map(Number);
    return p.y === y && p.m === m && p.day === day ? 1 : 0;
  }
  if (/^\d{4}-\d{2}$/.test(normalized)) {
    const [y, m] = normalized.split('-').map(Number);
    return p.y === y && p.m === m ? 0.8 : 0;
  }
  if (/^\d{4}$/.test(normalized)) return p.y === Number(normalized) ? 0.6 : 0;
  if (/^--\d{2}-\d{2}$/.test(normalized)) {
    const [m, day] = normalized.slice(2).split('-').map(Number);
    return p.m === m && p.day === day ? 0.7 : 0;
  }
  if (/^--\d{2}$/.test(normalized)) return p.m === Number(normalized.slice(2)) ? 0.5 : 0;
  if (/^---\d{2}$/.test(normalized)) return p.day === Number(normalized.slice(3)) ? 0.25 : 0;
  if (!normalized.startsWith('rel:')) return 0;

  const rel = normalized.slice(4).trim().toLocaleLowerCase();
  const refDay = _startOfLocalDay(referenceTimeMs);
  const docDay = _startOfLocalDay(docMs);
  const dayOffsets = new Map([
    ['今天', 0], ['today', 0], ['昨天', -1], ['yesterday', -1], ['前天', -2],
    ['明天', 1], ['tomorrow', 1], ['后天', 2],
  ]);
  if (dayOffsets.has(rel)) return docDay === refDay + dayOffsets.get(rel) * 86400000 ? 1 : 0;

  const ref = new Date(referenceTimeMs);
  if (rel === '去年' || rel === '明年') return p.y === ref.getFullYear() + (rel === '去年' ? -1 : 1) ? 0.6 : 0;
  if (rel === '上个月' || rel === '下个月' || rel === 'last month') {
    const delta = rel === '下个月' ? 1 : -1;
    const target = new Date(ref.getFullYear(), ref.getMonth() + delta, 1);
    return p.y === target.getFullYear() && p.m === target.getMonth() + 1 ? 0.8 : 0;
  }
  if (rel === '上周' || rel === '下周' || rel === 'last week' || rel === 'next week') {
    const day = ref.getDay() || 7;
    const weekStart = _startOfLocalDay(referenceTimeMs) - (day - 1) * 86400000;
    const delta = (rel === '下周' || rel === 'next week') ? 7 : -7;
    const start = weekStart + delta * 86400000;
    return docDay >= start && docDay < start + 7 * 86400000 ? 0.7 : 0;
  }
  return 0;
}

function _timeGranularity(normalized) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return 'date';
  if (/^\d{4}-\d{2}$/.test(normalized)) return 'year_month';
  if (/^\d{4}$/.test(normalized)) return 'year';
  if (/^--\d{2}-\d{2}$/.test(normalized)) return 'month_day';
  if (/^--\d{2}$/.test(normalized)) return 'month';
  if (/^---\d{2}$/.test(normalized)) return 'day_of_month';
  if (normalized.startsWith('rel:')) return 'relative';
  return 'unknown';
}

function _docTimeFactor(doc, anchors, referenceTimeMs) {
  const eventTs = doc?.ts == null ? Number.NaN : Number(doc.ts);
  const fileTs = doc?.fileTs == null ? Number.NaN : Number(doc.fileTs);
  const fileCreatedTime = doc?.fileCreatedTime == null ? Number.NaN : Number(doc.fileCreatedTime);
  const evidences = [
    ...(Number.isFinite(eventTs) ? [{ docMs: eventTs, source: 'record_time', strength: 1 }] : []),
    ...(Number.isFinite(fileTs) ? [{ docMs: fileTs, source: 'archive_path_time', strength: 0.8 }] : []),
    ...(Number.isFinite(fileCreatedTime) ? [{ docMs: fileCreatedTime, source: 'file_created_time', strength: 0.6 }] : []),
  ];
  if (!evidences.length || !anchors.length) return { quality: 0, bonus: 0, match: null };
  let best = null;
  for (const evidence of evidences) {
    for (const anchor of anchors) {
      const quality = _timeAnchorMatch(anchor, evidence.docMs, referenceTimeMs);
      if (quality <= 0) continue;
      // 只在实际匹配的证据里按 record > archive path > birthtime 决胜；同源再比粒度质量。
      if (!best || evidence.strength > best.evidence.strength
        || (evidence.strength === best.evidence.strength && quality > best.quality)) {
        best = { anchor, quality, evidence };
      }
    }
  }
  if (!best) return { quality: 0, bonus: 0, match: null };
  const evidence = best.evidence;
  const docMs = evidence.docMs;
  return {
    quality: best.quality,
    bonus: best.quality * evidence.strength * PARAMS.TIME_MATCH_BONUS,
    match: {
      raw: best.anchor.raw, normalized: best.anchor.normalized,
      granularity: _timeGranularity(best.anchor.normalized),
      source: evidence.source, recordTimeField: evidence.source === 'record_time' ? (doc.timeSource || 'event') : null,
      docTime: new Date(docMs).toISOString(), quality: best.quality, evidenceStrength: evidence.strength,
    },
  };
}

// ---- Gigatoken 桥 ----
const _docTokenCache = new Map();

export function clearRankCaches() {
  const before = { indexEntries: _idxCache.size, docTokenEntries: _docTokenCache.size };
  _idxCache.clear();
  _docTokenCache.clear();
  return before;
}

export async function llmTokenize(texts) {
  const r = await httpCall('llmtok', 'tokenize', { texts });
  if (r?._cluster_err || r?.error || !Array.isArray(r?.results)) {
    const error = new Error(`llmtok cluster failed: ${r?.error ?? 'invalid tokenize response'}`);
    error.code = 'P1_LLMTOK_CLUSTER_ERROR';
    error.details = { service: 'llmtok', response: r ?? null };
    throw error;
  }
  if (r.results.length !== texts.length || r.results.some(tokens => !Array.isArray(tokens))) {
    const error = new Error(`llmtok cluster contract mismatch: expected ${texts.length} result sets, got ${r.results.length}`);
    error.code = 'P1_LLMTOK_CLUSTER_CONTRACT_ERROR';
    error.details = { service: 'llmtok', expected: texts.length, actual: r.results.length };
    throw error;
  }
  return r;
}

// ---- 去重三层 ----
export async function dedupe(candidates) {
  const trace = [];
  const byWord = new Map();
  for (const c of candidates) {
    if (byWord.has(c.word)) trace.push({ removed: c.word, kept: c.word, rule: 'exact' });
    else byWord.set(c.word, c);
  }
  const words = [...byWord.keys()].sort((a, b) => b.length - a.length);
  const dead = new Set();
  for (let i = 0; i < words.length; i++) {
    if (dead.has(words[i])) continue;
    for (let j = i + 1; j < words.length; j++) {
      if (dead.has(words[j])) continue;
      if (words[j].length >= 2 && words[i].includes(words[j])) {
        dead.add(words[j]);
        trace.push({ removed: words[j], kept: words[i], rule: 'substring' });
      }
    }
  }
  for (const w of dead) byWord.delete(w);
  const remain = [...byWord.keys()];
  const pairs = [];
  for (let i = 0; i < remain.length; i++) {
    for (let j = i + 1; j < remain.length; j++) pairs.push([remain[i], remain[j]]);
  }
  const nb = pairs.length > 0
    ? await nbPairwiseBatch(pairs)
    : { available: false, why: 'fewer_than_2_candidates', cosines: [], covered: 0 };

  if (nb.available) {
    const pairCos = new Map();
    for (let i = 0; i < pairs.length; i++) {
      const rawCos = nb.cosines[i];
      if (rawCos === null || rawCos === undefined) continue;
      const cos = Number(rawCos);
      if (!Number.isFinite(cos)) continue;
      const [a, b] = pairs[i];
      if (!pairCos.has(a)) pairCos.set(a, new Map());
      if (!pairCos.has(b)) pairCos.set(b, new Map());
      pairCos.get(a).set(b, cos);
      pairCos.get(b).set(a, cos);
    }

    // 同义组保留与当前输入锚点更相关者；无锚点 cosine 时按 Node3 综合分，最后按原顺序稳定决胜。
    const originalOrder = new Map(remain.map((w, i) => [w, i]));
    const anchorCos = (w) => {
      const raw = byWord.get(w)?.factors?.nbCos;
      if (raw === null || raw === undefined) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const score = (w) => {
      const n = Number(byWord.get(w)?.score);
      return Number.isFinite(n) ? n : 0;
    };
    const priority = [...remain].sort((a, b) => {
      const ac = anchorCos(a), bc = anchorCos(b);
      if (ac !== null || bc !== null) {
        if (ac === null) return 1;
        if (bc === null) return -1;
        if (ac !== bc) return bc - ac;
      }
      if (score(a) !== score(b)) return score(b) - score(a);
      return originalOrder.get(a) - originalOrder.get(b);
    });
    const kept = [];
    for (const word of priority) {
      const synonym = kept.find((other) => (pairCos.get(word)?.get(other) ?? -1) > PARAMS.NB_DEDUP_THRESH);
      if (!synonym) {
        kept.push(word);
        continue;
      }
      byWord.delete(word);
      trace.push({
        removed: word,
        kept: synonym,
        rule: 'nb_synonym',
        pairCos: pairCos.get(word).get(synonym),
        cosA: anchorCos(synonym),
        cosB: anchorCos(word),
      });
    }
  }
  return {
    deduped: [...byWord.values()],
    trace,
    nbAvailable: nb.available,
    nbWhy: nb.why ?? null,
    nbPairCount: pairs.length,
    nbCoveredPairs: nb.covered ?? 0,
  };
}

// ---- BM25 ----
function bm25Scores(queryTerms, docsTokens) {
  const N = docsTokens.length;
  const avgdl = docsTokens.reduce((s, d) => s + d.length, 0) / Math.max(1, N);
  const df = new Map();
  for (const t of new Set(queryTerms)) df.set(t, docsTokens.filter(d => d.includes(t)).length);
  return docsTokens.map(doc => {
    let score = 0;
    const terms = [];
    for (const t of new Set(queryTerms)) {
      const tf = doc.filter(x => x === t).length;
      if (!tf) continue;
      const idf = Math.log((N - df.get(t) + 0.5) / (df.get(t) + 0.5) + 1);
      const s = idf * (tf * (PARAMS.BM25_K1 + 1)) / (tf + PARAMS.BM25_K1 * (1 - PARAMS.BM25_B + PARAMS.BM25_B * doc.length / avgdl));
      score += s;
      terms.push({ term: t, tf, idf: +idf.toFixed(3), s: +s.toFixed(3) });
    }
    return { score, terms };
  });
}

// ---- 短语级匹配 ----
function phraseRuns(queryTokens, docText) {
  let best = 0, run = 0, pos = -1, cursor = 0;
  for (const tok of queryTokens) {
    const found = docText.indexOf(tok, cursor);
    if (found >= 0 && (pos < 0 || found <= pos + tok.length + 2)) {
      run++; pos = found; cursor = found + tok.length;
    } else { best = Math.max(best, run); run = 0; pos = -1; cursor = 0; }
  }
  return Math.max(best, run);
}

// ---- 主入口 ----
const LAYER_W_DEFAULT = { hot: 1.0, warm: 0.85, cold: 0.7 };

export async function rank(scoredPool, node0Result, docs, {
  fusion = 'weighted', inputKeptWords = [], ctxDataTexts = new Set(),
  oovWords = new Set(), exactAnchorWords = new Set(), metadataAnchorWords = new Set(inputKeptWords), timeAnchors = [],
  referenceTimeMs, layerWeights, mode = 'chat', recencyDecayBase = 0.995,
  indexScopeKey, indexVersion, indexCacheMax,
  // 模块级验证可注入等价服务；生产 pipeline 不传，始终使用集群实现。
  llmTokenizer = llmTokenize, docTokenizer = bridgeTokenize,
} = {}) {
  if (fusion !== 'weighted' && fusion !== 'rrf') {
    const error = new RangeError(`unsupported node4 fusion: ${fusion}`);
    error.code = 'P1_NODE4_FUSION_INVALID';
    error.details = { fusion, supported: ['weighted', 'rrf'] };
    throw error;
  }
  const _lw = { ...LAYER_W_DEFAULT, ...(layerWeights || {}) };
  const _nowCandidate = referenceTimeMs == null ? Number.NaN : Number(referenceTimeMs);
  const _nowMs = Number.isFinite(_nowCandidate) ? _nowCandidate : Date.now();
  const _rdb = Math.max(0.9, Math.min(1.0, recencyDecayBase));
  const inputTexts = node0Result.units.filter(u => !u.excluded && u.type === 'user_current').map(u => u.raw);

  const gt = await llmTokenizer(inputTexts);
  const llmSeqs = gt.results;
  const {
    deduped, trace: dedupTrace, nbAvailable,
    nbWhy, nbPairCount, nbCoveredPairs,
  } = await dedupe(scoredPool.scored);

  // BLQ 分数决定去留: deduped 已按 score 降序, 只取高分词做查询(低分词=噪声, 不进索引查询)
  const queryDeduped = deduped.slice(0, PARAMS.ANCHOR_TOPN);
  const queryTerms = [...new Set([...inputKeptWords, ...queryDeduped.map(c => c.word)])];
  const inputSet = new Set(inputKeptWords);
  const dedupedMap = new Map(deduped.map(c => [c.word, c]));
  const topSet = new Set(deduped.slice(0, PARAMS.TOP_BONUS_N).map(c => c.word));

  // ---- 倒排索引查询: 每个 queryTerm O(1) 查出包含它的文档集 ----
  const { idx, cache: indexCache } = buildIndex(docs, {
    scopeKey: indexScopeKey || `direct:${mode}`,
    version: indexVersion,
    maxEntries: indexCacheMax,
  });
  const docHits = new Map(); // docIndex → [hitWord...]
  const exactDocHits = new Map(); // docIndex → [{word, source:body|metadata}]
  const addHit = (di, word) => {
    if (!docHits.has(di)) docHits.set(di, []);
    if (!docHits.get(di).includes(word)) docHits.get(di).push(word);
  };
  const addExact = (di, word, source) => {
    addHit(di, word);
    if (!exactDocHits.has(di)) exactDocHits.set(di, []);
    if (!exactDocHits.get(di).some(hit => hit.word === word && hit.source === source)) {
      exactDocHits.get(di).push({ word, source });
    }
  };
  for (const q of queryTerms) {
    const hitDocs = queryIndex(idx, q, docs);
    for (const di of hitDocs) addHit(di, q);
  }
  // metadata 词只按完整词相等直达；正文专名按字面精确命中直达。
  // 二者都只接受原始输入锚，不让发散词借此绕过正常候选门槛。
  const originalAnchors = new Set([...metadataAnchorWords].map(w => String(w ?? '').trim()).filter(Boolean));
  const properAnchors = new Set([...exactAnchorWords].map(w => String(w ?? '').trim()).filter(Boolean));
  for (const anchor of originalAnchors) {
    for (const di of queryMetadataExact(idx, anchor)) addExact(di, anchor, 'metadata');
  }
  for (const anchor of properAnchors) {
    for (let di = 0; di < docs.length; di++) {
      if (_bodyHasExactAnchor(docs[di].text, anchor)) addExact(di, anchor, 'body');
    }
    for (const di of queryMetadataExact(idx, anchor)) addExact(di, anchor, 'metadata');
  }
  // 时间事实是独立直达候选源，不伪装成 queryTerm/hit，也不进入发散。
  const timeDocMatches = new Map();
  if (timeAnchors.length) {
    for (let di = 0; di < docs.length; di++) {
      const factor = _docTimeFactor(docs[di], timeAnchors, _nowMs);
      if (factor.bonus <= 0) continue;
      timeDocMatches.set(di, factor);
      if (!docHits.has(di)) docHits.set(di, []);
    }
  }

  // 候选源: 普通命中门槛 / 精确锚直达 / 时间锚直达。
  const _shortInput = inputTexts.join('').length < PARAMS.SHORT_INPUT_CHARS;
  const candidates = [];
  let oovBypassCount = 0;
  let exactBypassCount = 0;
  let timeBypassCount = 0;
  const candidateTrace = [];
  for (const [di, hitWords] of docHits) {
    const minHits = _shortInput ? 1 : Math.max(1, Math.ceil(docs[di].text.length / PARAMS.HITS_DIVISOR));
    const normalAccepted = hitWords.length >= minHits;
    const exactHits = exactDocHits.get(di) ?? [];
    const exactAccepted = exactHits.length > 0;
    const timeFactor = timeDocMatches.get(di) ?? null;
    const timeAccepted = timeFactor != null;
    if (normalAccepted || exactAccepted || timeAccepted) {
      candidates.push(di);
      if (!normalAccepted && exactAccepted) {
        exactBypassCount++;
        if (exactHits.some(hit => oovWords.has(hit.word))) oovBypassCount++;
      }
      if (!normalAccepted && !exactAccepted && timeAccepted) timeBypassCount++;
    }
    const candidateSources = [
      ...(normalAccepted ? ['normal_threshold'] : []),
      ...(exactAccepted ? ['exact_anchor'] : []),
      ...(timeAccepted ? ['time_anchor'] : []),
    ];
    candidateTrace.push({
      id: docs[di].id ?? di, hitCount: hitWords.length, minHits,
      accepted: candidateSources.length > 0,
      acceptedBy: candidateSources[0] ?? null,
      candidateSources, exactHits, timeMatch: timeFactor?.match ?? null,
    });
  }
  let docTokensMode = `index(${docs.length}→${docHits.size}source→${candidates.length}candidate${exactBypassCount ? `,exact${exactBypassCount}` : ''}${timeBypassCount ? `,time${timeBypassCount}` : ''})`;

  // BM25 只对候选分词
  const needTok = candidates.filter(i => !Array.isArray(docs[i].tokens));
  if (needTok.length) {
    const uncached = needTok.filter(i => {
      const cached = _docTokenCache.get(docs[i].text);
      if (cached) { docs[i].tokens = cached; return false; }
      return true;
    });
    if (uncached.length) {
      const br = await docTokenizer(uncached.map(i => docs[i].text));
      uncached.forEach((docIdx, j) => {
        docs[docIdx].tokens = br.results[j].map(t => t.w);
        _docTokenCache.set(docs[docIdx].text, docs[docIdx].tokens);
      });
      if (_docTokenCache.size > 2000) {
        const keys = [..._docTokenCache.keys()];
        for (let i = 0; i < keys.length - 1500; i++) _docTokenCache.delete(keys[i]);
      }
    }
  }
  const candidateTokens = candidates.map(i => docs[i].tokens ?? []);
  const bmCand = bm25Scores(queryTerms, candidateTokens);
  const bmScores = new Map();
  candidates.forEach((di, j) => bmScores.set(di, bmCand[j]));

  // ---- 排序: 只对有命中的文档计算完整分数 ----
  const scoredDocs = [];
  for (const di of candidates) {
    const d = docs[di];
    const hitWords = docHits.get(di) ?? [];
    const hits = hitWords.map(w => {
      if (inputSet.has(w)) return { word: w, origin: 'input', top: false };
      const c = dedupedMap.get(w);
      return c ? { word: w, origin: 'diverge', top: topSet.has(w), score: c.score } : { word: w, origin: 'input', top: false };
    });
    const hitScore = hits.reduce((s, h) => {
      const blqW = h.origin === 'input' ? 1 : Math.max(0.1, h.score ?? 0.1);
      const oovBonus = (h.origin === 'input' && oovWords.has(h.word)) ? PARAMS.OOV_BONUS : 0;
      return s + PARAMS.HIT_WEIGHT * blqW + (h.top ? PARAMS.TOP_INPUT_BONUS : 0) + oovBonus;
    }, 0);
    const run = llmSeqs.length ? Math.max(...llmSeqs.map(seq => phraseRuns(seq, d.text))) : 0;
    const phraseBonus = run >= PARAMS.PHRASE_MIN_RUN ? run * PARAMS.PHRASE_WEIGHT : 0;
    const bm = bmScores.get(di);
    const exactHits = exactDocHits.get(di) ?? [];
    const exactAnchorBonus = exactHits.length ? PARAMS.EXACT_ANCHOR_BONUS : 0;
    const timeFactor = timeDocMatches.get(di) ?? _docTimeFactor(d, timeAnchors, _nowMs);
    const importance = _clamp01(d.weight) ?? _clamp01(d.importance) ?? 0;
    const pinned = d.pinned === true || d.top === true;
    const recordPinBonus = pinned ? PARAMS.RECORD_TOP_BONUS : 0;
    const recordImportanceBonus = importance * PARAMS.RECORD_IMPORTANCE_WEIGHT;
    const recordTopBonus = recordPinBonus + recordImportanceBonus;
    const layerW = _lw[d.layer] ?? _lw.warm;
    const eventTs = d.ts == null ? Number.NaN : Number(d.ts);
    const recency = Number.isFinite(eventTs)
      ? Math.pow(_rdb, Math.max(0, (_nowMs - eventTs) / 3600000))
      : null;
    const final = (bm?.score ?? 0) + hitScore + phraseBonus + layerW + (recency ?? 0)
      + exactAnchorBonus + timeFactor.bonus + recordTopBonus;
    scoredDocs.push({
      id: d.id ?? di, text: d.text,
      recordId: d.recordId ?? null,
      selfSource: ctxDataTexts.has(d.text),
      layer: d.layer || null,
      sourceRel: d.sourceRel || null,
      sourceType: d.sourceType || null,
      keywords: Array.isArray(d.keywords) ? d.keywords : [],
      tags: Array.isArray(d.tags) ? d.tags : [],
      eventTime: d.ts == null ? null : d.ts,
      eventTimeSource: d.timeSource ?? null,
      fileTime: d.fileTs ?? null,
      fileCreatedTime: d.fileCreatedTime ?? null,
      lastTriggered: d.lastTriggered ?? null,
      bm25: bm ? +bm.score.toFixed(4) : 0, bm25Terms: bm?.terms ?? [],
      hits, hitScore: +hitScore.toFixed(3),
      phraseRun: run, phraseBonus: +phraseBonus.toFixed(3),
      exactHits, exactAnchorBonus: +exactAnchorBonus.toFixed(3),
      timeMatch: timeFactor.match, timeBonus: +timeFactor.bonus.toFixed(3),
      recordTop: { pinned, top: d.top === true, importance, weight: d.weight ?? null },
      recordPinBonus: +recordPinBonus.toFixed(3),
      recordImportanceBonus: +recordImportanceBonus.toFixed(3),
      recordTopBonus: +recordTopBonus.toFixed(3),
      layerW: +layerW.toFixed(2),
      recency: recency == null ? null : +recency.toFixed(4),
      final: +final.toFixed(4),
    });
  }

  // 融合契约: final 始终保留加权公式的完整分解；rankScore 才是当前融合方式的实际排序分数。
  // RRF 对 BM25 / 关联词命中 / 短语加分三路分别排名，再按设计规格 Σ1/(k+rank) 融合。
  // 同分时按稳定文档身份、最后按原始顺序决胜，避免依赖 sort 实现或重复 id 覆盖排名。
  const sourceOrder = new Map(scoredDocs.map((doc, index) => [doc, index]));
  const stableTextCompare = (a, b) => {
    const ak = `${String(a.id)}\0${a.sourceRel ?? ''}\0${a.text}`;
    const bk = `${String(b.id)}\0${b.sourceRel ?? ''}\0${b.text}`;
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return sourceOrder.get(a) - sourceOrder.get(b);
  };

  if (fusion === 'rrf') {
    const ranks = (key) => new Map(
      [...scoredDocs]
        .sort((a, b) => (b[key] - a[key]) || stableTextCompare(a, b))
        .map((doc, index) => [doc, index + 1]),
    );
    const bm25Ranks = ranks('bm25');
    const hitRanks = ranks('hitScore');
    const phraseRanks = ranks('phraseBonus');
    const positiveRanks = (key) => new Map(
      scoredDocs.filter(doc => doc[key] > 0)
        .sort((a, b) => (b[key] - a[key]) || stableTextCompare(a, b))
        .map((doc, index) => [doc, index + 1]),
    );
    const exactRanks = positiveRanks('exactAnchorBonus');
    const timeRanks = positiveRanks('timeBonus');
    const recordRanks = positiveRanks('recordTopBonus');
    const rrfPart = (rankMap, doc) => rankMap.has(doc) ? 1 / (PARAMS.RRF_K + rankMap.get(doc)) : 0;
    for (const doc of scoredDocs) {
      doc.rrf = +(
        1 / (PARAMS.RRF_K + bm25Ranks.get(doc))
        + 1 / (PARAMS.RRF_K + hitRanks.get(doc))
        + 1 / (PARAMS.RRF_K + phraseRanks.get(doc))
        + rrfPart(exactRanks, doc)
        + rrfPart(timeRanks, doc)
        + rrfPart(recordRanks, doc)
      ).toFixed(5);
      doc.rankScore = doc.rrf;
    }
  } else {
    for (const doc of scoredDocs) doc.rankScore = doc.final;
  }

  const ordered = [...scoredDocs].sort((a, b) =>
    (b.rankScore - a.rankScore) || stableTextCompare(a, b));

  return {
    ranked: ordered,
    dedupTrace,
    llmTokenizer: gt.provider,
    docTokensMode,
    nbDedupAvailable: nbAvailable,
    nbDedupWhy: nbWhy,
    nbDedupPairCount: nbPairCount,
    nbDedupCoveredPairs: nbCoveredPairs,
    fusion,
    oovWords: [...oovWords],
    oovBypassCount,
    exactAnchorWords: [...properAnchors],
    exactBypassCount,
    timeBypassCount,
    timeAnchors,
    referenceTime: new Date(_nowMs).toISOString(),
    candidateTrace,
    indexCache,
    params: { ...PARAMS, fusion, rankScoreField: 'rankScore' },
  };
}
