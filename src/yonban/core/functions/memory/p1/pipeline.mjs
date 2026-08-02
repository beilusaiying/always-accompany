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

// input: {currentUserText, messages, dataRecords, docs?, mode?, fusion?}
// docs 缺省 = dataRecords 全量作为被检索文档(排序层的检索对象)
export async function runPipeline(input) {
  const mode = input.mode ?? 'chat';
  const inputDocs = input.docs ?? [];
  const inputMsgs = Array.isArray(input.messages) ? input.messages : [];
  const _noData = !inputDocs.length && !inputMsgs.length;
  const n0 = recallSelect({ ...input, mode });
  const n1 = await tokenizeUnits(n0);
  // 发散/查询锚词(凛倾锁定值 批13"chatContext<5取2词"): 当前输入全量,其余单元各取2词(BCC升序=低频内容词优先)
  const CTX_WORDS_PER_UNIT = Math.max(1, Math.min(10, Number(input.ctxWordsPerUnit) || parseInt(process.env.P1_CTX_WORDS_PER_UNIT, 10) || 2));
  const byUnit = new Map();
  for (const t of n1.contextTokens.filter(t => !t.filtered)) {
    if (!byUnit.has(t.unit)) byUnit.set(t.unit, []);
    byUnit.get(t.unit).push(t);
  }
  const anchorWords = [];
  for (const [ui, toks] of byUnit) {
    const isCurrent = n0.units[ui]?.type === 'user_current' || n0.units[ui]?.type === 'ai_output';
    const pick = isCurrent ? toks : [...toks].sort((a, b) => (a.bccFreq ?? 0) - (b.bccFreq ?? 0)).slice(0, CTX_WORDS_PER_UNIT);
    for (const t of pick) if (!anchorWords.includes(t.word)) anchorWords.push(t.word);
  }
  // 被检索库=data记录+"之前的记录"(设计§匹配): 召回窗口(最近3条user)之外的更早对话条
  const ctxRaws = new Set(n0.units.map(u => u.raw));
  const olderMsgs = (input.messages ?? [])
    .filter(m => m?.role === 'user' && m.content && !ctxRaws.has(m.content))
    .map((m, i) => ({ id: `hist_${i}`, text: m.content }));
  const n2 = await diverge(n1, mode, { mechanisms: input.mechanisms, anchorWords });
  const n3 = await scorePool(n2);
  if (_noData) {
    const empty = { ranked: [], dedupTrace: [], docTokensMode: 'pass(no_data)', oovWords: [], params: {} };
    return { n0, n1, n2, n3, n4: empty, mode, pass: true };
  }
  const docs = inputDocs.length ? inputDocs : [
    ...(input.dataRecords ?? []).map((r, i) => ({
      id: `data_${i}`, text: typeof r === 'string' ? r : (r?.text ?? r?.content ?? ''),
    })),
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
  const n4 = await rank(n3, n0, docsUniq, { fusion: input.fusion ?? 'weighted', inputKeptWords, ctxDataTexts, oovWords, layerWeights: input.layerWeights, mode, recencyDecayBase: input.recencyDecayBase });
  return { n0, n1, n2, n3, n4, mode };
}

// 全链白盒渲染: 入参=runPipeline 返回值 {n0..n4, mode};node0→node1 段委托 whitebox.mjs renderNode01,
// node2-4 段在此渲染(拆两处是历史顺序: 白盒随节点递进增补,渲染归属跟节点落位)
export function renderFullWhitebox(r) {
  const L = [];
  L.push(renderNode01(r.n0, r.n1));

  L.push('');
  L.push(`══════════ 白盒 node2 发散 (mode=${r.mode}) ══════════`);
  L.push('── 机制产出 ──');
  for (const m of r.n2.mechanisms) {
    L.push(`  ${m.mechanism}: ${m.produced} 候选${m.note ? `  ⚠ ${m.note}` : ''}`);
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
    L.push(`  ${s.score}  ${s.word}  vote=${f.vote}(共振${s.resonance}) ib=${f.ib}(d=${f.d}) logic=${f.logic ?? '-'}${ld ? `(${ld})` : ''} nov=${f.novelty} cos=${f.nbCos ?? '-'} gold=${f.goldilocks.zone} mode+${f.modeBonus}`);
  }
  if (r.n3.droppedByNb.length) {
    L.push(`── NB地板丢弃(cos<0.15): ${r.n3.droppedByNb.map(d => `${d.word}(${d.factors.nbCos})`).slice(0, 12).join(' ')} ──`);
  }

  L.push('');
  L.push('══════════ 白盒 node4 混合排序 ══════════');
  L.push(`llm分词=${r.n4.llmTokenizer}  doc分词=${r.n4.docTokensMode}  融合=${r.n4.fusion}`);
  if (r.n4.oovWords?.length) L.push(`OOV词=[${r.n4.oovWords.join(',')}] 绕过门槛${r.n4.oovBypassCount}条`);
  if (r.n4.dedupTrace.length) {
    L.push('── 去重 ──');
    for (const t of r.n4.dedupTrace.slice(0, 10)) L.push(`  ✗ ${t.removed} ⊂ ${t.kept} [${t.rule}]`);
  }
  L.push('── 文档排序(分数分解) ──');
  for (const d of r.n4.ranked) {
    L.push(`  ${d.final}${d.rrf !== undefined ? ` rrf=${d.rrf}` : ''}  [${d.id}] bm25=${d.bm25} hits=${d.hitScore}(${d.hits.map(h => h.word).join(',') || '无'}) phrase=${d.phraseBonus}(run${d.phraseRun})`);
    L.push(`      ${d.text.slice(0, 50)}${d.text.length > 50 ? '…' : ''}`);
  }
  return L.join('\n');
}
