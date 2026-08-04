// node3_score.mjs — 汇池审查: 标注 + 打分(自驱动召回新管线 第4节)
//
// 设计来源: P1_新管线设计_算法标注版.md §标注打分
// 审查机制: BLQ / NB300关联 / LogicScore四维 已接线;EmoBank VAD仅标注未计分;WordNet路径用于双重验证
// 标注层(NRC/conc78k)不产出候选,只给候选贴标签供审查过滤加权
//
// 白盒铁律: 每个候选输出完整因子分解 {vote, ib, logic, novelty, nbCos, goldilocks...},
// 每个因子标注真实来源;未接线因子=中性1.0并在 factorStatus 里如实声明,禁止假装有信号
// 红线: Vote 指数 α=1.2(改 1.0 退步, A01);Goldilocks 分段 0.15/0.25/0.70/0.80 已定档

import { httpCall } from './cluster.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadNrc, loadConc78k, loadEmobankVad } from './resources2.mjs';
import { loadMeldSch, loadBrysbaert } from './resources.mjs';
import { REL_WEIGHTS } from './node2_diverge.mjs';
import { STORAGE_ROOT } from './paths.mjs';

// NB300 + WordNet → 集群 vector_service :13152
// novelty_usage 按角色卡隔离: memDir 由调用方传入(p1_service_stdio → pipeline → scorePool)
// 拉线测试/无角色身份时也写 P1 storage，不反写资源目录。
const _USAGE_FALLBACK = join(STORAGE_ROOT, 'users', '_default', 'characters', '_global', 'novelty.json');
let _usageDir = null;
export function setUsageDir(dir) { _usageDir = dir; }
function _usagePath() { return _usageDir ? join(_usageDir, 'novelty.json') : _USAGE_FALLBACK; }

const envF = (n, d) => { const v = parseFloat(process.env[n]); return Number.isFinite(v) ? v : d; };

export const PARAMS = {
  VOTE_ALPHA: 1.2,                       // 红线,禁改(A01: 改 1.0 退步)
  IB_ALPHA: envF('P1_IB_ALPHA', 2.0),    // 旧实装 d/(1+2d²),倒U峰 d*≈0.707 [待白盒定]
  NB_ASSOC_FLOOR: 0.15,                  // Goldilocks 下界(已定档 p1_pool)
  // Goldilocks 4段: <0.15截断 / <0.25×0.7 / 0.25-0.70×1.0甜蜜区 / >0.70×0.8 / >0.80×0.5
  GOLDILOCKS: { NEAR: 0.25, FAR_LO: 0.70, FAR_HI: 0.80, W_NEAR: 0.7, W_FAR: 0.8, W_XFAR: 0.5 },
  // 模式调制加性系数(加性项,遵"严禁BLQ滥用乘法"红线)
  // 情绪标注命中数×模式权重的加成系数 [待实验定: 无实验数据,经验起步值]
  EMOTION_BONUS_W: envF('P1_EMOTION_BONUS_W', 0.1),
  // 术语域来源命中×模式权重的加成系数 [待实验定: 无实验数据,经验起步值]
  DOMAIN_BONUS_W: envF('P1_DOMAIN_BONUS_W', 0.2),
  // 池 CombSUM strength 对 final 的加成系数 [待实验定: 无实验数据,经验起步值]
  POOL_STRENGTH_W: envF('P1_POOL_STRENGTH_W', 0.3),
  // concreteness-78k 审查降权: 低于此阈值=抽象词,施加惩罚(设计§标注打分: "具体性过低降权或排除")
  // [待实验定: 78k 1-5量表,2.5=中位偏抽象;需真实case白盒读校确认合理性]
  CONC78K_PENALTY_THRESH: envF('P1_CONC78K_THRESH', 2.5),
  // concreteness-78k 惩罚系数: penalty = W × (阈值 - 实际值),越抽象惩罚越大
  CONC78K_PENALTY_W: envF('P1_CONC78K_PENALTY_W', 0.3),
  // BLQ 最低分截断线: score < 此值的候选词丢弃(设计要求"分数汇总决定去留")
  BLQ_SCORE_FLOOR: envF('P1_BLQ_SCORE_FLOOR', 0.1),
  // WordNet 双重验证阈值: NB cos 和 WN path_similarity 都 > 此值才保留(设计§L261-262)
  WN_DUAL_FLOOR: envF('P1_WN_DUAL_FLOOR', 0.1),
  // BLQ 模式权重(30号MD §模式权重;设计原文 modeWeights 四列逐字保留)
  // 消费现状: emotion/domain 进 modeBonus;logic 仅在有四维逻辑信号时调制 LogicScore;
  // user_pref 列无数值公式/数据源，仅保留设计原值并在 factorStatus 如实声明未消费
  MODE_WEIGHTS: {
    chat: { emotion: 1.0, logic: 1.0, domain: 1.0, user_pref: 0.5 },
    airp: { emotion: 1.5, logic: 0.8, domain: 1.0, user_pref: 0.5 },
    code: { emotion: 0, logic: 3.0, domain: 1.5, user_pref: 0.5 },
    work: { emotion: 0.3, logic: 1.5, domain: 2.0, user_pref: 0.5 },
  },
};

// ---- NB300 向量桥(mini.h5, python h5py 查询;不可用如实降级) ----
// 一次性批查: words → {word: cos_with_anchor_centroid};anchor=输入词集
let _nbAvailable = null;
export async function nbCosineBatch(anchorWords, candidateWords) {
  if (_nbAvailable === false) return { available: false, cos: new Map() };
  const r = await httpCall('vector', 'nb_cosine', { anchors: anchorWords, candidates: candidateWords });
  if (r._cluster_err) { _nbAvailable = false; return { available: false, why: r.error, cos: new Map() }; }
  if (r.available === false) return { available: false, why: r.why, cos: new Map() };
  _nbAvailable = true;
  return { available: true, cos: new Map(Object.entries(r.cos || {})), oov: r.oov };
}

// 候选词两两近义判断：一次请求批量计算 cos(w1,w2)，供 Node4 按框架阈值去重。
export async function nbPairwiseBatch(pairs) {
  const pairList = Array.isArray(pairs) ? pairs : [];
  if (pairList.length === 0) {
    return { available: false, why: 'empty_pairs', cosines: [], covered: 0, oov: [] };
  }
  if (_nbAvailable === false) {
    return { available: false, why: 'nb_unavailable', cosines: [], covered: 0, oov: [] };
  }
  const r = await httpCall('vector', 'nb_pairs', { pairs: pairList });
  if (r._cluster_err) {
    _nbAvailable = false;
    return { available: false, why: r.error, cosines: [], covered: 0, oov: [] };
  }
  if (r.available === false) {
    return { available: false, why: r.why, cosines: [], covered: 0, oov: r.oov ?? [] };
  }
  const cosines = Array.isArray(r.cosines) ? r.cosines : [];
  if (cosines.length !== pairList.length) {
    return {
      available: false,
      why: `bad_pair_response(${cosines.length}/${pairList.length})`,
      cosines,
      covered: Number(r.covered) || 0,
      oov: r.oov ?? [],
    };
  }
  _nbAvailable = true;
  return { available: true, cosines, covered: Number(r.covered) || 0, oov: r.oov ?? [] };
}

// ---- WordNet 路径相似度桥(设计 审查机制4;与 NB300 双重验证,阈值[白盒定]先标注不硬滤) ----
let _wnAvailable = null;
export async function wnSimBatch(anchorWords, candidateWords) {
  if (_wnAvailable === false) return { available: false, sim: new Map() };
  const r = await httpCall('vector', 'wn_sim', { anchors: anchorWords, candidates: candidateWords });
  if (r._cluster_err) { _wnAvailable = false; return { available: false, why: r.error, sim: new Map() }; }
  if (r.available === false) return { available: false, why: r.why, sim: new Map() };
  _wnAvailable = true;
  return { available: true, sim: new Map(Object.entries(r.sim || {})) };
}

// ---- Goldilocks 分段系数(Mednick+Kenett 倒U, 已定档) ----
export function goldilocksFactor(cos) {
  const G = PARAMS.GOLDILOCKS;
  if (cos === null || cos === undefined) return { factor: 1.0, zone: 'no_vector' };
  if (cos < PARAMS.NB_ASSOC_FLOOR) return { factor: 0, zone: 'drop(<0.15)' };
  if (cos < G.NEAR) return { factor: G.W_NEAR, zone: 'near' };
  if (cos <= G.FAR_LO) return { factor: 1.0, zone: 'sweet' };
  if (cos <= G.FAR_HI) return { factor: G.W_FAR, zone: 'far' };
  return { factor: G.W_XFAR, zone: 'xfar' };
}

// ---- IB 倒U: d = 1 - cos(语义距离), F = d/(1+α·d²) 归一到峰值=1 ----
export function ibFactor(cos) {
  if (cos === null || cos === undefined) return { ib: 1.0, d: null };
  const d = 1 - cos;
  const a = PARAMS.IB_ALPHA;
  const peak = (1 / Math.sqrt(a)) / (1 + a * (1 / a)); // d*=1/√α 处的最大值,用于归一
  const raw = d / (1 + a * d * d);
  return { ib: +(raw / peak).toFixed(3), d: +d.toFixed(3) };
}

// ---- LogicScore: 四维逻辑评分(BLQ 公式 LogicScore = max{演绎,归纳,溯因,对比}) ----
// 设计来源: P1_新管线设计_算法标注版.md §标注打分
// 四维语义(召回语境): 演绎=逻辑必然(Causes/HasSubevent), 归纳=同类泛化(IsA/cilin),
//   溯因=可能原因(MotivatedByGoal/CausesDesire), 对比=反差关系(Antonym/HasProperty)
// 无逻辑信号(SWOW 等纯联想机制)=中性 1.0,不影响 BLQ;有信号=max(四维 relWeight)
const REL_TO_LOGIC_DIM = {
  Causes: 'deduction', HasSubevent: 'deduction',
  IsA: 'induction',
  MotivatedByGoal: 'abduction', CausesDesire: 'abduction',
  Antonym: 'contrast', HasProperty: 'contrast',
};
const SOURCE_LOGIC = { cilin: { dim: 'induction', w: 0.5 } };

export function calcLogicFactors(poolEntry, mode = 'chat') {
  const dims = { deduction: 0, induction: 0, abduction: 0, contrast: 0 };
  for (const rel of poolEntry.rels ?? []) {
    const dim = REL_TO_LOGIC_DIM[rel];
    if (dim) dims[dim] = Math.max(dims[dim], REL_WEIGHTS[rel] ?? 0);
  }
  for (const src of poolEntry.sources ?? []) {
    const m = SOURCE_LOGIC[src];
    if (m) dims[m.dim] = Math.max(dims[m.dim], m.w);
  }
  const maxDim = Math.max(dims.deduction, dims.induction, dims.abduction, dims.contrast);
  const hasLogicSignal = maxDim > 0;
  const rawLogic = hasLogicSignal ? +maxDim.toFixed(3) : 1.0;
  // 模式权重只调制真实信号；无信号时权重也必须中性，不能凭空生成逻辑加成。
  const logicModeWeight = hasLogicSignal
    ? (PARAMS.MODE_WEIGHTS[mode] ?? PARAMS.MODE_WEIGHTS.chat).logic
    : 1.0;
  const weightedLogic = hasLogicSignal ? +(rawLogic * logicModeWeight).toFixed(3) : 1.0;
  return { rawLogic, logicModeWeight, weightedLogic, hasLogicSignal, dims };
}

// 预筛与最终打分共用同一 BLQ 公式，避免模式逻辑权重在某一阶段重复或漏计。
export function calcBlq({ vote, ib = 1.0, weightedLogic, novelty }) {
  return vote * ib * weightedLogic * novelty;
}

// ---- NoveltyBonus: 1/√(historical_count+1),使用记录落盘持久 ----
function loadUsage() {
  const p = _usagePath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`novelty usage is unreadable: ${p}: ${error.message}`), {
      code: 'P1_NOVELTY_STATE_CORRUPT', details: { path: p },
    });
  }
}
// 调用方=p1_pipeline/p1_service_stdio 召回出口(只记实际参与命中的扩展词);historyMode:false 时 scorePool 不读账本
export function recordUsage(words) {
  const u = loadUsage();
  for (const w of words) u[w] = (u[w] ?? 0) + 1;
  const target = _usagePath();
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temp, JSON.stringify(u));
  renameSync(temp, target);
}

// ---- 情感/具体性/VAD 标注(标注层: 不滤,只贴标签供模式加权) ----
function annotate(word, lang) {
  const tags = {};
  // EmoBank VAD 词级标注(英文,设计 §标注打分: EmoBank 审查机制)
  const ebVad = loadEmobankVad();
  if (ebVad.available) {
    const vad = ebVad.data.get(word.toLowerCase());
    if (vad) tags.emobank = vad;
  }
  if (lang === 'en') {
    const nrc = loadNrc();
    if (nrc.available && nrc.data.has(word)) tags.emotions = nrc.data.get(word);
    const c78 = loadConc78k();
    if (c78.available && c78.data.has(word)) tags.conc78k = c78.data.get(word);
    const brys = loadBrysbaert();
    const b = brys.get(word);
    if (b !== undefined) tags.concBrys = b;
  } else {
    const m = loadMeldSch().get(word);
    if (m !== undefined) tags.concMeld = m;
  }
  return tags;
}

// ---- 主入口: node2 pool → BLQ 预筛 → NB/WN 验证 → 完整打分 ----
// 两步架构: ① BLQ 预筛(Vote×Logic×Novelty, 不需要 NB)淘汰低质词
//           ② 存活的词才送 NB/WN 验证(减少网络请求量)
export async function scorePool(node2Result, { historyMode = true } = {}) {
  const { pool, inputWords, mode } = node2Result;
  const usage = historyMode ? loadUsage() : {};
  const mw = PARAMS.MODE_WEIGHTS[mode] ?? PARAMS.MODE_WEIGHTS.chat;
  const ebVad = loadEmobankVad();

  // ── 第一步: BLQ 预筛(纯语义因子, 不依赖 NB cos) ──
  const preScored = pool.map(p => {
    const lang = /\p{Script=Han}/u.test(p.word) ? 'zh' : 'en';
    const tags = annotate(p.word, lang);
    const vote = Math.pow(Math.max(1, p.resonance), PARAMS.VOTE_ALPHA);
    const { rawLogic, logicModeWeight, weightedLogic, hasLogicSignal, dims: logicDims } = calcLogicFactors(p, mode);
    const novelty = 1 / Math.sqrt((usage[p.word] ?? 0) + 1);
    let modeBonus = 0;
    if (tags.emotions?.length) modeBonus += mw.emotion * PARAMS.EMOTION_BONUS_W * tags.emotions.length;
    if (p.sources.some(s => ['abbr_expand', 'term_translate', 'definition_expand', 'basic_tech'].includes(s))) {
      modeBonus += mw.domain * PARAMS.DOMAIN_BONUS_W;
    }
    let concPenalty = 0;
    if (lang === 'en' && tags.conc78k !== undefined && tags.conc78k < PARAMS.CONC78K_PENALTY_THRESH) {
      concPenalty = PARAMS.CONC78K_PENALTY_W * (PARAMS.CONC78K_PENALTY_THRESH - tags.conc78k);
    }
    const preBlq = calcBlq({ vote, weightedLogic, novelty });
    const preScore = preBlq + modeBonus + p.strength * PARAMS.POOL_STRENGTH_W - concPenalty;
    return {
      ...p, lang, tags, vote,
      rawLogic, logicModeWeight, weightedLogic, hasLogicSignal, logicDims,
      novelty, modeBonus, concPenalty, preBlq, preScore,
    };
  });

  const droppedByBlq = preScored.filter(p => p.preScore < PARAMS.BLQ_SCORE_FLOOR);
  const survived = preScored.filter(p => p.preScore >= PARAMS.BLQ_SCORE_FLOOR);

  // ── 第二步: 存活的词才送 NB/WN(减少网络请求) ──
  const anchors = [...inputWords.zh, ...inputWords.en];
  const nb = survived.length ? await nbCosineBatch(anchors, survived.map(p => p.word)) : { available: false, cos: new Map(), why: 'empty_pool' };
  const enAnchors = inputWords.en ?? [];
  const enCands = survived.filter(p => p.lang === 'en').map(p => p.word);
  const wn = enAnchors.length && enCands.length ? await wnSimBatch(enAnchors, enCands) : { available: false, sim: new Map(), why: 'no_en' };

  const factorStatus = {
    vote: 'live(机制共振数)',
    ib: nb.available ? 'live(numberbatch int8子集 82.4万词)' : `neutral(NB不可用: ${nb.why ?? ''})`,
    goldilocks: nb.available ? 'live' : 'neutral(NB不可用)',
    logic: `live(rawLogic=max{演绎,归纳,溯因,对比};有信号×modeWeight=${mw.logic};无信号 raw/weight/weighted 均为中性1.0)`,
    novelty: historyMode ? 'live(novelty_usage.json)' : 'off',
    emotion: 'live(NRC标注命中数×模式权重,仅英文词表覆盖处)',
    emobank: ebVad.available
      ? `annotated_only(not consumed in score; emobank_word_vad ${ebVad.data.size}词)`
      : 'unavailable(not consumed in score)',
    domain: 'live(术语机制来源加成×模式权重)',
    user_pref: 'not_consumed(no numeric formula or data source)',
    wordnet: wn.available ? 'live(nltk path_similarity 双重验证硬过滤)' : `unavailable(${wn.why ?? ''})`,
    blqPreFilter: `${pool.length}→${survived.length}(预筛淘汰${droppedByBlq.length})`,
  };

  // ── 第三步: 完整 BLQ 打分(含 IB + Goldilocks, 依赖 NB cos) ──
  const scored = survived.map(p => {
    const cos = nb.cos.has(p.word) ? nb.cos.get(p.word) : null;
    const { ib, d } = ibFactor(cos);
    const gold = goldilocksFactor(cos);
    const blq = calcBlq({ vote: p.vote, ib, weightedLogic: p.weightedLogic, novelty: p.novelty });
    const final = blq * gold.factor + p.modeBonus + p.strength * PARAMS.POOL_STRENGTH_W - p.concPenalty;

    const wnSim = wn.sim.get(p.word) ?? null;
    let dropReason = null;
    if (gold.factor === 0) dropReason = 'nb_floor';
    else if (final < PARAMS.BLQ_SCORE_FLOOR) dropReason = 'blq_low_final';
    else if (p.lang === 'en' && cos !== null && wnSim !== null
             && (cos < PARAMS.WN_DUAL_FLOOR || wnSim < PARAMS.WN_DUAL_FLOOR)) dropReason = 'wn_dual';

    return {
      word: p.word, sources: p.sources, strength: p.strength, resonance: p.resonance, via: p.via,
      lang: p.lang, tags: p.tags,
      factors: { vote: +p.vote.toFixed(3), ib, d,
                 logic: p.weightedLogic, rawLogic: p.rawLogic, logicModeWeight: p.logicModeWeight,
                 weightedLogic: p.weightedLogic, hasLogicSignal: p.hasLogicSignal, logicDims: p.logicDims,
                 novelty: +p.novelty.toFixed(3),
                 nbCos: cos !== null ? +(+cos).toFixed(3) : null, wnSim,
                 goldilocks: gold, modeBonus: +p.modeBonus.toFixed(3) },
      score: +final.toFixed(4),
      dropped: dropReason !== null,
      dropReason,
    };
  });

  const keptScored = scored.filter(s => !s.dropped).sort((a, b) => b.score - a.score);
  const droppedByNb = scored.filter(s => s.dropReason === 'nb_floor');
  const droppedByBlqFinal = scored.filter(s => s.dropReason === 'blq_low_final');
  const droppedByWn = scored.filter(s => s.dropReason === 'wn_dual');

  return {
    mode, scored: keptScored,
    droppedByBlq: [...droppedByBlq.map(p => ({ word: p.word, score: +p.preScore.toFixed(4), sources: p.sources, dropReason: 'blq_pre' })),
                   ...droppedByBlqFinal.map(s => ({ word: s.word, score: s.score, sources: s.sources, dropReason: 'blq_final' }))],
    droppedByNb, droppedByWn,
    factorStatus, nbAvailable: nb.available, params: { ...PARAMS },
  };
}
