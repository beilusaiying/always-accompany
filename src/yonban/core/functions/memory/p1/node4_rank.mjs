// node4_rank.mjs — 混合排序: 倒排索引 + BM25 + 关联词命中 + 短语匹配
//
// 设计来源: P1_新管线设计_算法标注版.md §混合排序
// 架构: 文档集半静态(三层记忆) → 建倒排索引(一次) → 查询词 O(1) 查索引 → 候选集 → BM25+hits+phrase 排序
// 链: 发散产出 → Gigatoken(LLM分词第二视角) → 去重 → 索引查询 → BM25+hits+phrase → 综合排序

import { httpCall } from './cluster.mjs';
import { nbCosineBatch } from './node3_score.mjs';
import { bridgeTokenize } from './node1_tokenize.mjs';

const envF = (n, d) => { const v = parseFloat(process.env[n]); return Number.isFinite(v) ? v : d; };

const envI = (n, d) => { const v = parseInt(process.env[n], 10); return Number.isFinite(v) ? v : d; };
const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const PARAMS = {
  BM25_K1: 1.2,
  BM25_B: 0.75,
  HIT_WEIGHT: envF('P1_HIT_WEIGHT', 0.5),
  PHRASE_WEIGHT: envF('P1_PHRASE_WEIGHT', 0.3),
  PHRASE_MIN_RUN: 3,
  NB_DEDUP_THRESH: 0.85,
  // NB 近义去重: 与锚点质心 cos 分差小于此值的相邻对视为近义候选,留分高者
  // [待实验定: 经验起步值,阈值过大→误杀非近义,过小→漏去重]
  NB_DEDUP_COS_DIFF: envF('P1_NB_DEDUP_COS_DIFF', 0.02),
  RRF_K: 60,
  TOP_INPUT_BONUS: 0.2,
  OOV_BONUS: envF('P1_OOV_BONUS', 0.5),
  // anchor 词取 scored pool 前 N 个(控制匹配查询宽度) [待实验定: 经验起步值]
  ANCHOR_TOPN: clampI(envI('P1_ANCHOR_TOPN', 30), 5, 100),
  // "top也是加分项": 从去重后发散池取前 N 个作为 top 加分候选 [待实验定: 经验起步值]
  TOP_BONUS_N: clampI(envI('P1_TOP_BONUS_N', 10), 1, 50),
  // 短输入宽松召回: 输入 < SHORT_INPUT_CHARS 字时 minHits 固定为 1(不按文档长度计算)
  SHORT_INPUT_CHARS: 12,
  // 文档候选门槛除数: minHits = ceil(docLen / HITS_DIVISOR); 默认 10=每 10 字需 1 命中
  HITS_DIVISOR: 10,
};

// ---- 倒排索引(per-mode 缓存: 多窗口场景 code/work/chat 各自持有索引,不互相覆盖) ----
const _idxByMode = new Map();

function buildIndex(docs, mode) {
  const fingerprint = docs.length + ':' + (docs[0]?.text?.slice(0, 20) ?? '') + ':' + (docs[docs.length - 1]?.text?.slice(0, 20) ?? '');
  const cached = _idxByMode.get(mode);
  if (cached && cached.fp === fingerprint) return cached;

  const posting = new Map();
  for (let i = 0; i < docs.length; i++) {
    const t = docs[i].text;
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
  }
  const idx = { fp: fingerprint, posting, size: docs.length };
  _idxByMode.set(mode, idx);
  if (_idxByMode.size > 8) {
    const oldest = _idxByMode.keys().next().value;
    _idxByMode.delete(oldest);
  }
  return idx;
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

// ---- Gigatoken 桥 ----
const _docTokenCache = new Map();
let _gtState = null, _gtWhy = null;

export async function llmTokenize(texts) {
  if (_gtState !== 'dead') {
    const r = await httpCall('llmtok', 'tokenize', { texts });
    if (!r._cluster_err && !r.error && r.results) { _gtState = 'live'; return r; }
    _gtState = 'dead';
    _gtWhy = r.error || 'llmtok service unavailable';
  }
  return {
    provider: `fallback:char_bigram(${_gtWhy ?? ''})`,
    results: texts.map(t => {
      const s = t.replace(/\s+/g, '');
      const out = [];
      for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
      return out;
    }),
  };
}

// ---- 去重三层 ----
export function dedupe(candidates, anchorWords) {
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
  const nb = nbCosineBatch(anchorWords, remain);
  if (nb.available && remain.length > 1) {
    const ranked = remain.filter(w => nb.cos.has(w)).sort((a, b) => nb.cos.get(b) - nb.cos.get(a));
    for (let i = 0; i + 1 < ranked.length; i++) {
      const a = ranked[i], b = ranked[i + 1];
      if (byWord.has(a) && byWord.has(b) && Math.abs(nb.cos.get(a) - nb.cos.get(b)) < PARAMS.NB_DEDUP_COS_DIFF && nb.cos.get(a) > PARAMS.NB_DEDUP_THRESH) {
        byWord.delete(b);
        trace.push({ removed: b, kept: a, rule: 'nb_synonym', cosA: nb.cos.get(a), cosB: nb.cos.get(b) });
      }
    }
  }
  return { deduped: [...byWord.values()], trace, nbAvailable: nb.available };
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

export async function rank(scoredPool, node0Result, docs, { fusion = 'weighted', inputKeptWords = [], ctxDataTexts = new Set(), oovWords = new Set(), layerWeights, mode = 'chat', recencyDecayBase = 0.995 } = {}) {
  const _lw = { ...LAYER_W_DEFAULT, ...(layerWeights || {}) };
  const _nowMs = Date.now();
  const _rdb = Math.max(0.9, Math.min(1.0, recencyDecayBase));
  const anchorWords = scoredPool.scored.slice(0, PARAMS.ANCHOR_TOPN).map(s => s.word);
  const inputTexts = node0Result.units.filter(u => !u.excluded && u.type === 'user_current').map(u => u.raw);

  const gt = await llmTokenize(inputTexts);
  const llmSeqs = gt.results;
  const { deduped, trace: dedupTrace, nbAvailable } = dedupe(scoredPool.scored, anchorWords);

  // BLQ 分数决定去留: deduped 已按 score 降序, 只取高分词做查询(低分词=噪声, 不进索引查询)
  const QUERY_TOP_K = Math.max(5, Math.min(20, deduped.length));
  const queryDeduped = deduped.slice(0, QUERY_TOP_K);
  const queryTerms = [...new Set([...inputKeptWords, ...queryDeduped.map(c => c.word)])];
  const inputSet = new Set(inputKeptWords);
  const dedupedMap = new Map(deduped.map(c => [c.word, c]));
  const topSet = new Set(deduped.slice(0, PARAMS.TOP_BONUS_N).map(c => c.word));

  // ---- 倒排索引查询: 每个 queryTerm O(1) 查出包含它的文档集 ----
  const idx = buildIndex(docs, mode);
  const docHits = new Map(); // docIndex → [hitWord...]
  for (const q of queryTerms) {
    const hitDocs = queryIndex(idx, q, docs);
    for (const di of hitDocs) {
      if (!docHits.has(di)) docHits.set(di, []);
      docHits.get(di).push(q);
    }
  }

  // BM25 候选: 命中数达到长度门槛(每 HITS_DIVISOR 字需 1 命中); 短输入放宽到 1
  const _shortInput = inputTexts.join('').length < PARAMS.SHORT_INPUT_CHARS;
  const candidates = [];
  let oovBypassCount = 0;
  for (const [di, hitWords] of docHits) {
    const minHits = _shortInput ? 1 : Math.max(1, Math.ceil(docs[di].text.length / PARAMS.HITS_DIVISOR));
    if (hitWords.length >= minHits) {
      candidates.push(di);
    } else if (hitWords.some(w => oovWords.has(w))) {
      candidates.push(di);
      oovBypassCount++;
    }
  }
  let docTokensMode = `index(${docs.length}→${docHits.size}hit→${candidates.length}bm25${oovBypassCount ? `,oov${oovBypassCount}` : ''})`;

  // BM25 只对候选分词
  const needTok = candidates.filter(i => !Array.isArray(docs[i].tokens));
  if (needTok.length) {
    const uncached = needTok.filter(i => {
      const cached = _docTokenCache.get(docs[i].text);
      if (cached) { docs[i].tokens = cached; return false; }
      return true;
    });
    if (uncached.length) {
      try {
        const br = await bridgeTokenize(uncached.map(i => docs[i].text));
        uncached.forEach((docIdx, j) => {
          docs[docIdx].tokens = br.results[j].map(t => t.w);
          _docTokenCache.set(docs[docIdx].text, docs[docIdx].tokens);
        });
        if (_docTokenCache.size > 2000) {
          const keys = [..._docTokenCache.keys()];
          for (let i = 0; i < keys.length - 1500; i++) _docTokenCache.delete(keys[i]);
        }
      } catch {
        uncached.forEach(di => { docs[di].tokens = [...docs[di].text].filter(c => /\S/.test(c)); });
        docTokensMode += '(fallback:char)';
      }
    }
  }
  const candidateTokens = candidates.map(i => docs[i].tokens ?? []);
  const bmCand = bm25Scores(queryTerms, candidateTokens);
  const bmScores = new Map();
  candidates.forEach((di, j) => bmScores.set(di, bmCand[j]));

  // ---- 排序: 只对有命中的文档计算完整分数 ----
  const scoredDocs = [];
  for (const [di, hitWords] of docHits) {
    const d = docs[di];
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
    scoredDocs.push({
      id: d.id ?? di, text: d.text,
      selfSource: ctxDataTexts.has(d.text),
      layer: d.layer || null,
      sourceRel: d.sourceRel || null,
      sourceType: d.sourceType || null,
      bm25: bm ? +bm.score.toFixed(4) : 0, bm25Terms: bm?.terms ?? [],
      hits, hitScore: +hitScore.toFixed(3),
      phraseRun: run, phraseBonus: +phraseBonus.toFixed(3),
      layerW: +(_lw[d.layer] ?? _lw.warm).toFixed(2),
      recency: d.ts ? +Math.pow(_rdb, Math.max(0, (_nowMs - d.ts) / 3600000)).toFixed(4) : null,
      final: +((bm?.score ?? 0) + hitScore + phraseBonus + (_lw[d.layer] ?? _lw.warm) + (d.ts ? Math.pow(_rdb, Math.max(0, (_nowMs - d.ts) / 3600000)) : 0)).toFixed(4),
    });
  }

  const ordered = scoredDocs.sort((a, b) => (a.selfSource - b.selfSource) || b.final - a.final);

  return {
    ranked: ordered,
    dedupTrace,
    llmTokenizer: gt.provider,
    docTokensMode,
    nbDedupAvailable: nbAvailable,
    fusion,
    oovWords: [...oovWords],
    oovBypassCount,
    params: { ...PARAMS },
  };
}
