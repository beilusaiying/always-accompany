// pipeline.mjs — 自驱动召回全链编排(node0 → node1 → node2 → node3 → node4)
//
// 设计来源: P1_新管线设计_算法标注版.md 全篇
// 白盒原则(凛倾 2026-08-01): 白盒远比任何实验好——renderFullWhitebox(runPipeline(input)) 一条输入打出全链因果
// 下游消费方: p1_pipeline.mjs(前端契约 shim) / p1_service_stdio.mjs(常驻服务) 读 n1.timeAnchors / n3.scored / n4.ranked

import { recallSelect } from './node0_recall.mjs';
import { tokenizeUnits } from './node1_tokenize.mjs';
import { diverge } from './node2_diverge.mjs';
import { scorePool } from './node3_score.mjs';
import { rank } from './node4_rank.mjs';
import { renderNode01 } from './whitebox.mjs';

// input: {currentUserText, messages, dataRecords, contextCount?, dataCount?, docs?, mode?, fusion?, indexScopeKey?, indexVersion?, storageDiagnostics?}
// docs 缺省 = dataRecords 全量作为被检索文档(排序层的检索对象)
export async function runPipeline(input) {
  const pipelineStarted = performance.now();
  const timings = {};
  let stageStarted = pipelineStarted;
  const mode = input.mode ?? 'chat';
  const inputDocs = input.docs ?? [];
  const inputMsgs = Array.isArray(input.messages) ? input.messages : [];
  const inputDataRecords = Array.isArray(input.dataRecords) ? input.dataRecords : [];
  const _noData = !inputDocs.length && !inputMsgs.length && !inputDataRecords.length;
  const n0 = recallSelect({ ...input, mode });
  timings.node0Ms = +(performance.now() - stageStarted).toFixed(1);
  stageStarted = performance.now();
  const n1 = await tokenizeUnits(n0);
  timings.node1Ms = +(performance.now() - stageStarted).toFixed(1);
  stageStarted = performance.now();
  // 发散/查询锚词(凛倾锁定值 批13"chatContext<5取2词"): 当前输入全量,其余单元各取2词(BCC升序=低频内容词优先)
  const CTX_WORDS_PER_UNIT = Math.max(1, Math.min(10, Number(input.ctxWordsPerUnit) || parseInt(process.env.P1_CTX_WORDS_PER_UNIT, 10) || 2));
  const byUnit = new Map();
  for (const t of n1.contextTokens.filter(t => !t.filtered)) {
    if (!byUnit.has(t.unit)) byUnit.set(t.unit, []);
    byUnit.get(t.unit).push(t);
  }
  const anchorWords = [];
  for (const [ui, toks] of byUnit) {
    const isCurrent = n0.units[ui]?.type === 'user_current';
    const pick = isCurrent ? toks : [...toks].sort((a, b) => (a.bccFreq ?? 0) - (b.bccFreq ?? 0)).slice(0, CTX_WORDS_PER_UNIT);
    for (const t of pick) if (!anchorWords.includes(t.word)) anchorWords.push(t.word);
  }
  // 被检索库=data记录+"之前的记录"(设计§匹配): 召回窗口(最近N条user)之外的更早对话条
  const ctxRaws = new Set(n0.units.map(u => u.raw));
  const olderMsgs = (input.messages ?? [])
    .filter(m => m?.role === 'user' && m.content && !ctxRaws.has(m.content))
    .map((m, i) => ({ id: `hist_${i}`, text: m.content }));
  const n2 = await diverge(n1, mode, { mechanisms: input.mechanisms, anchorWords, userVocab: input.userVocab });
  timings.node2Ms = +(performance.now() - stageStarted).toFixed(1);
  stageStarted = performance.now();
  const n3 = await scorePool(n2);
  timings.node3Ms = +(performance.now() - stageStarted).toFixed(1);
  if (_noData) {
    const empty = { ranked: [], dedupTrace: [], docTokensMode: 'pass(no_data)', oovWords: [], params: {} };
    timings.node4Ms = 0;
    timings.totalMs = +(performance.now() - pipelineStarted).toFixed(1);
    return { n0, n1, n2, n3, n4: empty, mode, pass: true, timings, storageDiagnostics: input.storageDiagnostics ?? [] };
  }
  const docs = inputDocs.length ? inputDocs : [
    ...inputDataRecords.map((r, i) => (typeof r === 'string'
      ? { id: `data_${i}`, text: r }
      : { ...r, id: r?.id ?? `data_${i}`, text: r?.text ?? r?.content ?? '' })),
    ...olderMsgs,
  ];
  const inputKeptWords = anchorWords; // 查询主词=锚词集(与发散同源,收口单点)
  // 自指排除(0731回填闭环教训,recentDataTopK=0定档同理): 最近2条data是发散语境源,
  // 它们的词会成为查询词,若再匹配自身=自己召回自己刷分;且它们已在语境里,召回零信息增量
  const ctxDataTexts = new Set(n0.units.filter(u => u.type === 'data' && !u.excluded).map(u => u.raw));
  // 被检索库同文本去重(拉线0801: 快照表格重复行导致同条霸占多席)
  const seenDoc = new Set();
  const docsUniq = docs.filter(d => {
    const k = d.text.trim();
    if (seenDoc.has(k)) return false;
    seenDoc.add(k);
    return true;
  });
  // OOV 词集(node1 标记 oov=true 且保留的文字 token): 专名词/ACG术语/未登录词
  // 传给 node4: OOV 命中绕过长度门槛 + hitScore 加分(稀有词命中=高信息密度)
  const oovWords = new Set(
    n1.contextTokens
      .filter(t => !t.filtered && t.oov && /\p{L}/u.test(t.word))
      .map(t => t.word)
  );
  const properPos = new Set(['nr', 'ns', 'nt', 'nz', 'nx', 'nrt']);
  const currentInputTokens = n1.contextTokens
    .filter(t => !t.filtered && t.unitType === 'user_current' && /\p{L}/u.test(t.word));
  const metadataAnchorWords = new Set(n1.contextTokens
    .filter(t => t.unitType === 'user_current' && /\p{L}/u.test(t.word)
      && (!t.filtered || ['conc', 'pos', 'frq'].includes(t.reason)))
    .map(t => t.word));
  const exactAnchorWords = new Set(
    currentInputTokens
      .filter(t => t.oov || properPos.has(t.pos) || t.upos === 'PROPN')
      .map(t => t.word)
  );
  const queryTimeAnchors = n1.timeAnchors.filter(a => n0.units[a.unit]?.type === 'user_current');
  stageStarted = performance.now();
  const n4 = await rank(n3, n0, docsUniq, {
    fusion: input.fusion ?? 'weighted', inputKeptWords, ctxDataTexts, oovWords,
    exactAnchorWords, metadataAnchorWords, timeAnchors: queryTimeAnchors, referenceTimeMs: input.referenceTimeMs,
    layerWeights: input.layerWeights, mode, recencyDecayBase: input.recencyDecayBase,
    indexScopeKey: input.indexScopeKey,
    // 只有被检索库确实来自 storage docs 时，storage 版本才能作为索引版本；
    // 无记忆文档时会拼接动态 chatHistory，交给 node4 做全文哈希，避免跨对话误复用。
    indexVersion: inputDocs.length ? input.indexVersion : undefined,
    indexCacheMax: input.indexCacheMax,
  });
  timings.node4Ms = +(performance.now() - stageStarted).toFixed(1);
  timings.totalMs = +(performance.now() - pipelineStarted).toFixed(1);
  return { n0, n1, n2, n3, n4, mode, timings, storageDiagnostics: input.storageDiagnostics ?? [] };
}

// Production trace keeps the Node3 explanation contract without copying the
// whole internal score object. The fixed cap matches the existing panel's
// bounded diagnostic use while scoredCount continues to report the full count.
export const SCORED_POOL_TRACE_LIMIT = 50;
export function buildScoredPoolTrace(scoredCandidates) {
  return (Array.isArray(scoredCandidates) ? scoredCandidates : [])
    .slice(0, SCORED_POOL_TRACE_LIMIT)
    .map((candidate) => ({
      word: candidate.word,
      score: candidate.score,
      sources: candidate.sources,
      resonance: candidate.resonance,
      cos: candidate.factors?.nbCos,
      gold: candidate.factors?.goldilocks?.zone,
      factors: {
        // logic is the compatibility alias for the effective weighted factor.
        logic: candidate.factors?.logic ?? null,
        rawLogic: candidate.factors?.rawLogic ?? null,
        logicModeWeight: candidate.factors?.logicModeWeight ?? null,
        weightedLogic: candidate.factors?.weightedLogic ?? null,
        hasLogicSignal: candidate.factors?.hasLogicSignal ?? null,
      },
    }));
}

// 全链白盒渲染: 入参=runPipeline 返回值 {n0..n4, mode};node0→node1 段委托 whitebox.mjs renderNode01,
// node2-4 段在此渲染(拆两处是历史顺序: 白盒随节点递进增补,渲染归属跟节点落位)
export function renderFullWhitebox(r) {
  const L = [];
  L.push(renderNode01(r.n0, r.n1));

  L.push('');
  if (r.timings) L.push(`节点耗时 node0=${r.timings.node0Ms}ms node1=${r.timings.node1Ms}ms node2=${r.timings.node2Ms}ms node3=${r.timings.node3Ms}ms node4=${r.timings.node4Ms}ms total=${r.timings.totalMs}ms`);
  L.push(`══════════ 白盒 node2 发散 (mode=${r.mode}) ══════════`);
  L.push(`Node2 状态=${r.n2.status ?? 'unreported'} 错误=${r.n2.errors?.length ?? 0}`);
  L.push('── 机制产出 ──');
  for (const m of r.n2.mechanisms) {
    const unit = m.kind === 'filter' ? '处理' : '候选';
    L.push(`  ${m.mechanism}: status=${m.status ?? 'unreported'} ${m.produced} ${unit}${m.note ? `  ⚠ ${m.note}` : ''}`);
  }
  if (r.n2.errors?.length) {
    L.push('── 机制错误(可选机制降级、不伪装成无命中) ──');
    for (const error of r.n2.errors) {
      L.push(`  ✗ ${error.mechanism ?? '-'} ${error.code ?? 'E_P1_MECHANISM_UNAVAILABLE'}: ${error.message ?? '-'}`);
    }
  }
  L.push(`── 汇池 (${r.n2.pool.length} 词, 共振≥2 = ${r.n2.pool.filter(p => p.resonance >= 2).length}) ──`);
  for (const p of r.n2.pool.slice(0, 25)) {
    L.push(`  ${p.resonance >= 2 ? '★' : ' '} ${p.word}  [${p.sources.join('+')}] str=${p.strength.toFixed(2)} via=${p.via.slice(0, 3).join(',')}`);
  }
  if (r.n2.pool.length > 25) L.push(`  …共 ${r.n2.pool.length} 词(白盒截显 25)`);
  if (r.n2.wnDomainFiltered?.length) {
    L.push(`── WN supersense 域过滤(code/work→动物域抑制) ──`);
    for (const f of r.n2.wnDomainFiltered) L.push(`  ✗ ${f.word} [${f.domains.join(',')}] src=${f.sources.join('+')}`);
  }
  if (r.n2.removedBySecondPass.length) {
    const g = {};
    for (const x of r.n2.removedBySecondPass) (g[x.reason] ??= []).push(x.word);
    L.push('── 二次过滤滤除 ──');
    for (const [reason, ws] of Object.entries(g)) L.push(`  ✗ ${reason}: ${ws.slice(0, 15).join(' ')}${ws.length > 15 ? ` …+${ws.length - 15}` : ''}`);
  }

  L.push('');
  L.push('══════════ 白盒 node3 打分 ══════════');
  L.push('── 因子接线状态 ──');
  for (const [k, v] of Object.entries(r.n3.factorStatus)) L.push(`  ${k}: ${v}`);
  L.push('── Top 打分(全因子分解) ──');
  for (const s of r.n3.scored.slice(0, 15)) {
    const f = s.factors;
    const ld = f.logicDims ? Object.entries(f.logicDims).filter(([,v])=>v>0).map(([k,v])=>`${k[0]}${v}`).join('/') : '';
    const logicSignal = f.hasLogicSignal === true
      ? 'signal'
      : (f.hasLogicSignal === false ? 'no-signal neutral' : 'signal-unreported');
    L.push(`  ${s.score}  ${s.word}  vote=${f.vote}(共振${s.resonance}) ib=${f.ib}(d=${f.d}) logic=${f.logic ?? '-'}${ld ? `(${ld})` : ''} [raw×mode=weighted: ${f.rawLogic ?? '-'}×${f.logicModeWeight ?? '-'}=${f.weightedLogic ?? '-'}; ${logicSignal}] nov=${f.novelty} cos=${f.nbCos ?? '-'} gold=${f.goldilocks.zone} mode+${f.modeBonus}`);
  }
  if (r.n3.droppedByNb.length) {
    L.push(`── NB地板丢弃(cos<0.15): ${r.n3.droppedByNb.map(d => `${d.word}(${d.factors.nbCos})`).slice(0, 12).join(' ')} ──`);
  }

  L.push('');
  L.push('══════════ 白盒 node4 混合排序 ══════════');
  L.push(`llm分词=${r.n4.llmTokenizer}  doc分词=${r.n4.docTokensMode}  融合=${r.n4.fusion}`);
  L.push(`NB近义去重=${r.n4.nbDedupAvailable ? 'live' : `neutral(${r.n4.nbDedupWhy ?? '未运行'})`} 词对=${r.n4.nbDedupCoveredPairs ?? 0}/${r.n4.nbDedupPairCount ?? 0}`);
  if (r.n4.indexCache) L.push(`索引=${r.n4.indexCache.hit ? '缓存命中' : '重建'} 版本=${r.n4.indexCache.version} 来源=${r.n4.indexCache.versionSource} 文档=${r.n4.indexCache.docCount}`);
  if (r.n4.oovWords?.length) L.push(`OOV词=[${r.n4.oovWords.join(',')}] 精确绕过门槛${r.n4.oovBypassCount}条`);
  if (r.n4.exactAnchorWords?.length) L.push(`精确锚=[${r.n4.exactAnchorWords.join(',')}] 直达绕过${r.n4.exactBypassCount}条`);
  if (r.n4.timeAnchors?.length) L.push(`时间定向=[${r.n4.timeAnchors.map(a => a.normalized).join(',')}] 基准=${r.n4.referenceTime} 直达绕过=${r.n4.timeBypassCount ?? 0}条`);
  if (r.storageDiagnostics?.length) {
    L.push('── 存储诊断 ──');
    for (const d of r.storageDiagnostics) L.push(`  ${d.kind} ${d.code} ${d.path}: ${d.message}`);
  }
  if (r.n4.dedupTrace.length) {
    L.push('── 去重 ──');
    for (const t of r.n4.dedupTrace.slice(0, 10)) L.push(`  ✗ ${t.removed} ⊂ ${t.kept} [${t.rule}]`);
  }
  L.push('── 文档排序(分数分解) ──');
  for (const d of r.n4.ranked) {
    L.push(`  ${d.final}${d.rrf !== undefined ? ` rrf=${d.rrf}` : ''}  [${d.id}] bm25=${d.bm25} hits=${d.hitScore}(${d.hits.map(h => h.word).join(',') || '无'}) phrase=${d.phraseBonus}(run${d.phraseRun})`);
    L.push(`      exact=${d.exactAnchorBonus}(${d.exactHits.map(h => `${h.word}:${h.source}`).join(',') || '无'}) time=${d.timeBonus}(${d.timeMatch ? `${d.timeMatch.normalized}/${d.timeMatch.granularity}/${d.timeMatch.source}` : '无'}) recordTop=${d.recordTopBonus}(pin=${d.recordPinBonus},imp=${d.recordImportanceBonus}) layer=${d.layerW} recency=${d.recency ?? '-'}`);
    if (d.keywords.length || d.tags.length || d.lastTriggered != null) {
      L.push(`      metadata keywords=[${d.keywords.join(',')}] tags=[${d.tags.join(',')}] lastTriggered=${d.lastTriggered ?? '-'}`);
    }
    L.push(`      ${d.text.slice(0, 50)}${d.text.length > 50 ? '…' : ''}`);
  }
  return L.join('\n');
}
