// p1_pipeline.mjs — 前端契约兼容层(P1 自驱动召回·白盒新管线 shim)
//
// 契约(与旧链逐字一致,前端 beilu-p1-selfdriven PIPELINE_PATH 零改动):
//   runPipeline(inputText, chatHistory, mode, userCtx, opts) → {p1_act: string[≤15], ...}
//   getPromptHandler 把 p1_act 包成 <p1_act> XML 注入 depthInjections
//
// 新管线: node0召回预处理→node1分词三层过滤→node2发散(可插拔机制汇池)→node3打分→node4混合排序
// 设计: D:\shajiuguan\自驱动召回\P1_新管线设计_算法标注版.md
// 白盒原则(凛倾2026-08-01): 任意一条输入可打全链因果报告(opts.whitebox=true)

import { runPipeline as corePipeline, renderFullWhitebox } from './pipeline.mjs';
import { recordUsage } from './node3_score.mjs';

// 旧模式名 → 新管线四模式(smart/bot 走 chat 权重;ide 是 code 的旧称)
const MODE_MAP = { chat: 'chat', airp: 'airp', code: 'code', work: 'work', ide: 'code', smart: 'chat', bot: 'chat' };

export async function runPipeline(inputText, chatHistory = [], mode = 'chat', userCtx = {}, opts = {}) {
  try {
    // data 记录来源(储存+池):
    //   1) opts.recall.dataRecords / opts.dataRecords 直接注入(调用方已读好)
    //   2) TODO 接 beilu-memory: 按 userCtx(_username+charName) 角色卡级隔离读取——储存通道下一步接线,
    //      接线前 data 召回段为空数组=只做上下文发散,不假装有数据
    const dataRecords = opts.dataRecords ?? opts.recall?.dataRecords ?? [];

    const r = await corePipeline({
      currentUserText: String(inputText ?? ''),
      messages: Array.isArray(chatHistory) ? chatHistory : [],
      dataRecords,
      mode: MODE_MAP[mode] ?? 'chat',
      fusion: opts.fusion ?? opts.recall?.fusion,
      mechanisms: opts.mechanisms ?? opts.recall?.mechanisms, // 可插拔: {disable:['cilin',...]}
    });

    // 框架产出(凛倾设计 §匹配): 排序后的 data/记忆记录——"匹配的词越多越靠前,top也是加分项"。
    // 发散打分词只是查询扩展的中间产物,不出口(白盒可见)。
    const TOP_RECALL = Math.max(1, Math.min(20, opts.topRecall ?? opts.recall?.recordTopK ?? 5)); // recall.recordTopK=前端既有键(断点②修正)
    const recalled = r.n4.ranked
      .filter(d => d.final > 0 && !d.selfSource)
      .slice(0, TOP_RECALL)
      .map(d => ({ id: d.id, text: d.text, score: d.final, bm25: d.bm25, hits: d.hits.map(h => h.word), phraseRun: d.phraseRun }));
    // 注入物 = 召回的记忆原文(p1_act 字段名保留兼容前端透传,内容语义=召回记录文本)
    const p1_act = recalled.map(d => d.text);
    // NoveltyBonus 池记账: 记的是实际参与命中的扩展词(下次降新鲜度),不是出口物
    const usedWords = [...new Set(recalled.flatMap(d => d.hits))];
    if (opts.recordUsage !== false && usedWords.length) recordUsage(usedWords);

    // recalledRecords: 与 p1_server.py /runP1 响应同 schema({layer,matchedTerms,content},p1Bridge 消费方零改动)
    const recalledRecords = recalled.map(d => ({
      layer: String(d.id).split('_')[0] || null,
      matchedTerms: d.hits,
      content: d.text,
      score: d.score,
    }));
    return {
      success: true,
      engine: 'p1v2_whitebox',
      p1_act,
      recalled,
      recalledRecords,
      expansionWords: r.n3.scored.slice(0, 15).map(s => ({ term: s.word, score: s.score, sources: s.sources })), // 中间产物,仅观测
      timeAnchors: r.n1.timeAnchors,
      v5: null, // 旧链契约字段: 前端 main.mjs:438 透传 result.v5||null,新管线无 v5 语义,固定 null 保形状
      whitebox: opts.whitebox ? renderFullWhitebox(r) : undefined,
    };
  } catch (e) {
    // 契约: 失败返回可判定形状,不抛穿前端(main.mjs L437 依赖 result 非 null 判定)
    return { success: false, engine: 'p1v2_whitebox', p1_act: [], error: e?.message ?? String(e) };
  }
}

// 缓存清理(前端 _clearCaches 契约,断点⑤): 清词表 memo + NB/WN/gigatoken 粘性降级标记由进程重启处理
export async function clearP1RuntimeCaches() {
  const { clearResourceCaches } = await import('./resources.mjs');
  const { clearResourceCaches: clear2 } = await import('./resources2.mjs');
  clearResourceCaches?.();
  clear2?.();
  return { cleared: true };
}
