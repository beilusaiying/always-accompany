// config_map.mjs — 配置收口: config.json(前端可写单源) → 各节点 PARAMS 运行时覆盖
//
// 传导链(0801 前端调查定案): p1panel → shells:p1 relay → p1_server.py updateConfig →
//   config.json(真相盘) → runP1 请求携带 config → 本模块 applyConfig → PARAMS 生效
// why 不走 env: 前端没有写 env 的通道(宿主进程启动前才能设),env 保留为开发者覆盖(优先级最低,
//   config 值到达时覆盖 env 初始化的默认)。禁止硬编码的收口位=这张映射表,新参数必须在此登记。
//
// 红线参数不进映射(VOTE_ALPHA/REL_WEIGHTS/NB_ASSOC_FLOOR/Goldilocks——A01 红线禁改,配置面不暴露)

import { PARAMS as P0 } from './node0_recall.mjs';
import { PARAMS as P1 } from './node1_tokenize.mjs';
import { PARAMS as P2 } from './node2_diverge.mjs';
import { PARAMS as P3 } from './node3_score.mjs';
import { PARAMS as P4 } from './node4_rank.mjs';

const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

// config 键(camelCase, 前端面板/config.json) → [目标 PARAMS 对象, 键, 钳制]
const MAP = [
  ['contextMessages',   P0, 'CONTEXT_COUNT',     v => num(v, 0, 20)], // 复用 py 服务既有键
  ['dataCount',         P0, 'DATA_COUNT',        v => num(v, 0, 20)],
  ['shortSegmentChars', P0, 'SHORT_SENT_MIN',    v => num(v, 2, 50)],
  ['inputMaxWords',     P0, 'MAX_WORDS',         v => num(v, 20, 500)],
  ['truncHeadRatio',    P0, 'TRUNC_HEAD_RATIO',  v => num(v, 0.1, 0.9)],
  ['aiOutputCount',     P0, 'AI_OUTPUT_COUNT',   v => num(v, 0, 5)],
  ['concFloor',         P1, 'CONC_FLOOR',        v => num(v, 1, 5)],
  ['enConcFloor',       P1, 'EN_CONC_FLOOR',     v => num(v, 1, 5)],
  ['enFreqHigh',        P1, 'EN_FREQ_HIGH',      v => num(v, 0, 99999999)],
  ['swowTopK',          P2, 'SWOW_TOPK',         v => num(v, 1, 30)],
  ['swowMinSupZh',      P2, 'SWOW_MIN_SUPPORT_ZH', v => num(v, 1, 5)],
  ['cnTopK',            P2, 'CN_TOPK',           v => num(v, 1, 50)],
  ['cilinMaxL3',        P2, 'CILIN_MAX_L3',      v => num(v, 0, 10)],
  ['cilinMaxL2',        P2, 'CILIN_MAX_L2',      v => num(v, 0, 10)],
  ['atomicTopK',        P2, 'ATOMIC_TOPK',       v => num(v, 1, 20)],
  ['ibAlpha',           P3, 'IB_ALPHA',          v => num(v, 0.5, 8)],
  ['bm25K1',            P4, 'BM25_K1',           v => num(v, 0.1, 3)],
  ['bm25B',             P4, 'BM25_B',            v => num(v, 0, 1)],
  ['hitWeight',         P4, 'HIT_WEIGHT',        v => num(v, 0, 5)],
  ['phraseWeight',      P4, 'PHRASE_WEIGHT',     v => num(v, 0, 5)],
  ['phraseMinRun',      P4, 'PHRASE_MIN_RUN',    v => num(v, 2, 10)],
  ['topInputBonus',     P4, 'TOP_INPUT_BONUS',   v => num(v, 0, 2)],
  ['shortInputChars',  P4, 'SHORT_INPUT_CHARS', v => num(v, 1, 100)],
  ['hitsDivisor',      P4, 'HITS_DIVISOR',      v => num(v, 2, 100)],
  ['oovBonus',         P4, 'OOV_BONUS',         v => num(v, 0, 3)],
  ['anchorTopN',       P4, 'ANCHOR_TOPN',       v => num(v, 5, 100)],
  ['topBonusN',        P4, 'TOP_BONUS_N',       v => num(v, 1, 50)],
  ['nbDedupCosDiff',   P4, 'NB_DEDUP_COS_DIFF', v => num(v, 0, 0.5)],
  ['emotionBonusW',    P3, 'EMOTION_BONUS_W',   v => num(v, 0, 2)],
  ['domainBonusW',     P3, 'DOMAIN_BONUS_W',    v => num(v, 0, 2)],
  ['poolStrengthW',    P3, 'POOL_STRENGTH_W',   v => num(v, 0, 2)],
  ['conc78kPenaltyThresh', P3, 'CONC78K_PENALTY_THRESH', v => num(v, 1, 5)],
  ['conc78kPenaltyW',  P3, 'CONC78K_PENALTY_W', v => num(v, 0, 2)],
  ['blqScoreFloor',   P3, 'BLQ_SCORE_FLOOR',   v => num(v, 0, 5)],
  ['wnDualFloor',     P3, 'WN_DUAL_FLOOR',     v => num(v, 0, 1)],
];

// EN_FREQ_HIGH/AI_OUTPUT_COUNT 目前是模块级 const 非 PARAMS 键——applyConfig 前先在各节点补挂,
// 见 node0/node1 的 PARAMS 补丁(缺键时本函数跳过并计入 skipped,白盒可见不静默)

export function applyConfig(cfg = {}) {
  const applied = {}, skipped = [];
  for (const [key, target, pkey, clampFn] of MAP) {
    if (!(key in cfg)) continue;
    const v = clampFn(cfg[key]);
    if (v === undefined) { skipped.push(`${key}(bad value)`); continue; }
    if (!(pkey in target)) { skipped.push(`${key}(no PARAMS.${pkey})`); continue; }
    target[pkey] = v;
    applied[key] = v;
  }
  return { applied, skipped };
}
