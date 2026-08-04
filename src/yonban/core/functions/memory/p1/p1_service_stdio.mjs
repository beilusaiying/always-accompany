// p1_service_stdio.mjs — P1 新管线常驻子进程(行协议 JSONL)
//
// 功能链: p1_server.py(HTTP 服务壳,002 拍板可插拔架构) spawn 本进程(一次) →
//   stdin 每行一个 JSON 请求 → runPipeline → stdout 每行一个 JSON 响应
// why 常驻: 词库(BCC/meld/userdict)与 HanLP 模型加载秒级,spawnSync 每请求冷启不可用;
//   常驻进程加载一次,后续请求毫秒-百毫秒级。py 壳负责 config/词库管理 endpoint,本进程只跑管线。
//
// 行协议:
//   → {action:'health'}                          ← {ok, uptimeSec, resources}
//   → {action:'warmup', config}                  ← {success, readyForRecall, resources}
//   → {action:'runP1', inputText, chatHistory, historyChatId, mode, username, charName, chatId, config, whitebox?}
//   ← {success, p1_act, recalledRecords:[{recordId,layer,date,pinned,importance,rankingEvidence,...}],
//      directionWords, trace:{request,node1,recall:{ranking,storageDiagnostics,userVocab}}, whitebox?, error?}
//   响应形状与 p1_server.py /runP1 返回块同 schema(p1Bridge/前端消费方零改动)

import readline from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  runPipeline,
  renderFullWhitebox,
  buildScoredPoolTrace,
  SCORED_POOL_TRACE_LIMIT,
} from './pipeline.mjs';
import { applyConfig } from './config_map.mjs';
import { loadThreeLayerMemory, clearMemoryCache } from './storage_read.mjs';
import { recordUsage, setUsageDir } from './node3_score.mjs';
import { buildIndexTrace } from './index_trace.mjs';
import { clearRankCaches } from './node4_rank.mjs';
import { httpCall } from './cluster.mjs';
import { resourceReport } from './resources.mjs';
import { warmLocalResources2 } from './resources2.mjs';
import { clearTokenizeCache, tokenizeCacheReport } from './node1_tokenize.mjs';

const RUNTIME_CONTRACT = JSON.parse(readFileSync(new URL('./runtime_contract.json', import.meta.url), 'utf8'));
const _started = Date.now();
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const finiteOr = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const boundedInt = (value, fallback, min, max) => (
  Math.max(min, Math.min(max, Math.trunc(finiteOr(value, fallback))))
);
const resolveDataRecall = (req, cfg) => (
  typeof req?.dataRecall === 'boolean' ? req.dataRecall : cfg?.dataRecall !== false
);
const rankScoreOf = (ranked) => ranked?.rankScore ?? ranked?.final ?? 0;
const isOutputEligible = (ranked) => {
  if (rankScoreOf(ranked) <= 0) return false;
  if (ranked?.selfSource !== true) return true;
  // recentDocs 只是 P1 内部 Node0 的“最近 Data”查询语境，并没有被宿主直接注入。
  // 因而不能把它们一概从最终召回裁掉；当前用户的专名/metadata 精确锚或时间锚
  // 直接命中时，必须允许同一记录输出。纯上下文自激活仍维持排除，防止数据自己召回自己。
  return (Array.isArray(ranked?.exactHits) && ranked.exactHits.length > 0)
    || ranked?.timeMatch != null;
};
const rankingTrace = (node4) => ({
  fusion: node4?.params?.fusion ?? null,
  rankScoreField: node4?.params?.rankScoreField ?? null,
  exactAnchorWords: node4?.exactAnchorWords ?? [],
  exactBypassCount: node4?.exactBypassCount ?? 0,
  oovBypassCount: node4?.oovBypassCount ?? 0,
  timeAnchors: node4?.timeAnchors ?? [],
  referenceTime: node4?.referenceTime ?? null,
  candidateTrace: node4?.candidateTrace ?? [],
  top: (node4?.ranked ?? []).slice(0, 10).map(ranked => ({
    id: ranked.id ?? null,
    recordId: ranked.recordId ?? null,
    final: ranked.final ?? null,
    rrf: ranked.rrf ?? null,
    rankScore: ranked.rankScore ?? ranked.final ?? null,
    bm25: ranked.bm25 ?? null,
    hitScore: ranked.hitScore ?? null,
    phraseBonus: ranked.phraseBonus ?? null,
    exactHits: ranked.exactHits ?? [],
    exactAnchorBonus: ranked.exactAnchorBonus ?? null,
    timeMatch: ranked.timeMatch ?? null,
    timeBonus: ranked.timeBonus ?? null,
    recordTop: ranked.recordTop ?? null,
    recordPinBonus: ranked.recordPinBonus ?? null,
    recordImportanceBonus: ranked.recordImportanceBonus ?? null,
    recordTopBonus: ranked.recordTopBonus ?? null,
    layerW: ranked.layerW ?? null,
    recency: ranked.recency ?? null,
    selfSource: ranked.selfSource === true,
  })),
});
const queueTrace = (queue) => queue ? {
  sequence: queue.sequence,
  ahead: queue.ahead,
  enqueuedAt: queue.enqueuedAt,
  startedAt: queue.startedAt,
  waitMs: queue.startedAt - queue.enqueuedAt,
} : null;
const requestTrace = (req, n0 = null, context = {}) => ({
  inputText: String(req?.inputText ?? ''),
  inputChars: String(req?.inputText ?? '').length,
  historyCount: Array.isArray(req?.chatHistory) ? req.chatHistory.length : 0,
  mode: String(req?.mode ?? req?.activeMode ?? ''),
  username: String(req?.username ?? ''),
  charName: String(req?.charName ?? ''),
  chatId: String(req?.chatId ?? ''),
  historyChatId: String(req?.historyChatId ?? ''),
  historyOwnership: String(req?.historyOwnership ?? ''),
  source: String(req?.source ?? ''),
  requestScope: {
    username: String(req?.username ?? ''),
    charName: String(req?.charName ?? ''),
    chatId: String(req?.chatId ?? ''),
    mode: String(req?.mode ?? req?.activeMode ?? ''),
  },
  chatContextBound: Boolean(String(req?.chatId ?? '').trim()),
  dataRecall: context.dataRecall ?? null,
  queue: queueTrace(context.queue),
  node0Units: n0?.units?.map((u, index) => ({
    index,
    type: u.type,
    raw: u.raw,
    chars: u.raw.length,
    excluded: u.excluded,
    excludeReason: u.excludeReason,
    jaccard: u.jaccard ?? null,
    threshold: u.threshold ?? null,
    copyMatched: u.copyMatched === true,
    sentences: u.sentences,
  })) ?? [],
});
const fourLayerScope = (req, mode = String(req?.mode ?? req?.activeMode ?? '')) => ({
  username: String(req?.username ?? ''),
  charName: String(req?.charName ?? ''),
  chatId: String(req?.chatId ?? ''),
  mode: String(mode),
});
const fourLayerIndexTrace = (indexCache, req, cfg, mode, mem) => {
  const base = buildIndexTrace(indexCache, { ...req, mode }, cfg);
  if (!base) return null;
  const requestScope = fourLayerScope(req, mode);
  const sourceScope = mem?.sourceScope ?? null;
  const indexScope = mem?.indexScope ?? null;
  return {
    ...base,
    // 旧 scope 展示位现在明确代表不含 chatId 的共享物理源；请求隔离另列 requestScope。
    scope: sourceScope,
    requestScope,
    sourceScope,
    indexScope,
    chatContextBound: Boolean(requestScope.chatId.trim()),
  };
};
const node1Trace = (n0, n1) => {
  const tokens = n1?.contextTokens ?? [];
  return {
    provider: n1?.provider ?? null,
    resources: n1?.resources ?? null,
    ecdict: n1?.resources?.ecdict ?? n1?.provider?.ecdict ?? null,
    units: (n0?.units ?? []).map((unit, index) => ({
      index,
      type: unit.type,
      tokens: tokens.filter(t => t.unit === index).map(t => ({
        word: t.word,
        pos: t.pos,
        segmenterPos: t.segmenterPos ?? null,
        modelPos: t.modelPos ?? null,
        modelTag: t.modelTag ?? null,
        corePos: t.corePos ?? null,
        posSource: t.posSource ?? null,
        ...(t.upos ? { upos: t.upos } : {}),
        ecdictFrq: t.ecdictFrq ?? null,
        ecdictEnabled: t.ecdictEnabled ?? null,
        ecdictAvailable: t.ecdictAvailable ?? null,
        ecdictStatus: t.ecdictStatus ?? null,
        filtered: t.filtered,
        reason: t.reason ?? null,
        keptBy: t.keptBy ?? null,
      })),
    })),
  };
};
const failureEnvelope = (req, stage, error, context = {}) => ({
  success: false,
  p1_act: [],
  code: error?.code ?? null,
  error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
  trace: {
    request: requestTrace(req, null, context),
    failure: {
      stage,
      code: error?.code ?? null,
      error: error?.message ?? String(error),
      details: error?.details ?? null,
    },
  },
});

function loadUserVocab(vocabRoot, mode) {
  if (!vocabRoot || !existsSync(vocabRoot)) return { available: true, files: 0, entries: [] };
  const entries = [];
  let files = 0;
  for (const file of readdirSync(vocabRoot).filter(name => name.endsWith('.json')).sort()) {
    let data;
    try { data = JSON.parse(readFileSync(join(vocabRoot, file), 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      throw Object.assign(new Error(`user vocab is unreadable: ${file}: ${error.message}`), {
        code: 'P1_USER_VOCAB_CORRUPT', details: { file },
      });
    }
    const meta = data?._meta ?? {};
    const modes = Array.isArray(meta.modes) && meta.modes.length ? meta.modes : ['all'];
    if (meta.enabled === false || (!modes.includes('all') && !modes.includes(mode))) continue;
    files += 1;
    for (const [from, related] of Object.entries(data?.entries ?? {})) {
      if (!Array.isArray(related)) continue;
      for (const to of related) if (typeof to === 'string' && to.trim()) {
        entries.push({ from: String(from), to: to.trim(), file });
      }
    }
  }
  return { available: true, files, entries };
}

async function handleRunP1(req, queue) {
  const requestStarted = performance.now();
  let memoryLoadMs = null;
  let pipelineCallMs = null;
  let stage = 'config';
  let dataRecall = null;
  try {
  const cfg = req.config ?? {};
  const windowLayer = String(req.mode ?? req.activeMode ?? '').trim();
  if (!windowLayer) throw Object.assign(new Error('missing host window layer (mode/activeMode)'), { code: 'P1_WINDOW_LAYER_MISSING' });
  dataRecall = resolveDataRecall(req, cfg);
  const cfgResult = applyConfig(cfg);

  // 宿主记忆是只读输入；P1 novelty/实验/运行记录只写 storage/p1。
  stage = 'memory_load';
  const memoryStarted = performance.now();
  if (!req.stateRoot) throw Object.assign(new Error('missing P1 stateRoot'), { code: 'P1_STATE_ROOT_MISSING' });
  setUsageDir(req.stateRoot);
  const mem = dataRecall
    ? loadThreeLayerMemory(req.username, req.charName, req.chatId, cfg.dataRoot, windowLayer, {
      includeMarkdown: cfg.includeMarkdown,
      indexCacheMax: cfg.indexCacheMax,
      dataCount: cfg.dataCount,
      memoryFileMaxBytes: cfg.memoryFileMaxBytes,
      memoryUserRoot: req.memoryRoot,
    })
    : {
      docs: [], recentDocs: [], layerCounts: { hot: 0, warm: 0, cold: 0 },
      why: 'disabled_by_config', cacheHit: false,
      requestScope: fourLayerScope(req, windowLayer),
      sourceScope: null, indexScope: null,
      chatContextBound: Boolean(String(req.chatId ?? '').trim()),
      indexScopeKey: null, indexVersion: null,
    };
  memoryLoadMs = +(performance.now() - memoryStarted).toFixed(1);
  const memoryReason = dataRecall
    ? (mem.why ?? (mem.cacheHit ? 'loaded_from_cache' : 'loaded'))
    : 'disabled_by_config';

  stage = 'pipeline';
  const layerWeights = ['layerWeightHot', 'layerWeightWarm', 'layerWeightCold'].some(key => cfg[key] != null)
    ? {
      hot: finiteOr(cfg.layerWeightHot, 1.0),
      warm: finiteOr(cfg.layerWeightWarm, 0.85),
      cold: finiteOr(cfg.layerWeightCold, 0.7),
    }
    : undefined;
  const pipelineInput = {
    currentUserText: String(req.inputText ?? ''),
    messages: Array.isArray(req.chatHistory) ? req.chatHistory : [],
    mode: windowLayer,
    // Node0 输入选择必须是请求级合同，不能只依赖 applyConfig 对模块 PARAMS 的全局改写。
    // 这样同一进程内不同窗口/请求不会互相串用上下文条数。
    contextCount: boundedInt(cfg.contextMessages, 5, 0, 5),
    dataCount: boundedInt(cfg.dataCount, 2, 0, 20),
    ctxWordsPerUnit: cfg.ctxWordsPerUnit,
    fusion: cfg.fusion,
    mechanisms: cfg.mechDisable ? { disable: String(cfg.mechDisable).split(',').map(s => s.trim()).filter(Boolean) } : undefined,
    layerWeights,
    recencyDecayBase: finiteOr(cfg.recencyDecayBase, 0.995),
    indexCacheMax: cfg.indexCacheMax,
    userVocab: loadUserVocab(req.vocabRoot, windowLayer),
    storageDiagnostics: mem.diagnostics ?? [],
  };
  if (dataRecall) {
    pipelineInput.docs = mem.docs;
    pipelineInput.dataRecords = mem.recentDocs ?? [];
    pipelineInput.indexScopeKey = mem.indexScopeKey;
    pipelineInput.indexVersion = mem.indexVersion;
  }
  const pipelineStarted = performance.now();
  const r = await runPipeline(pipelineInput);
  pipelineCallMs = +(performance.now() - pipelineStarted).toFixed(1);

  stage = 'result_mapping';
  const topRecall = boundedInt(cfg.recordTopK, 5, 1, 50);
  const snippetMax = boundedInt(cfg.snippetMaxChars, 240, 40, 2000);
  const directionTopK = boundedInt(cfg.entryTopK, 20, 5, 50);
  const directionWords = [...new Set((r.n3?.scored ?? []).map(s => s.word).filter(Boolean))].slice(0, directionTopK);
  const picked = r.n4.ranked.filter(isOutputEligible).slice(0, topRecall);
  let recalledRecords = picked.map(d => ({
    id: d.id ?? null,
    recordId: d.recordId ?? null,
    layer: d.layer || String(d.id).split('_')[0] || null,
    sourceRel: d.sourceRel || null,
    sourceType: d.sourceType || null,
    keywords: d.keywords ?? [],
    tags: d.tags ?? [],
    eventTime: d.eventTime ?? null,
    eventTimeSource: d.eventTimeSource ?? null,
    fileTime: d.fileTime ?? null,
    fileCreatedTime: d.fileCreatedTime ?? null,
    lastTriggered: d.lastTriggered ?? null,
    pinned: d.recordTop?.pinned === true,
    top: d.recordTop?.top === true,
    importance: d.recordTop?.importance ?? null,
    weight: d.recordTop?.weight ?? null,
    matchedTerms: d.hits.map(h => h.word),
    exactHits: d.exactHits ?? [],
    exactAnchorBonus: d.exactAnchorBonus ?? 0,
    timeMatch: d.timeMatch ?? null,
    timeBonus: d.timeBonus ?? 0,
    recordPinBonus: d.recordPinBonus ?? 0,
    recordImportanceBonus: d.recordImportanceBonus ?? 0,
    recordTopBonus: d.recordTopBonus ?? 0,
    content: d.text.length > snippetMax ? d.text.slice(0, snippetMax) + '…' : d.text,
    score: rankScoreOf(d),
  }));
  // injectMaxChars: 注入总字符上限(0=不限, 与 Python p1_node0_data_recall.py 对齐)
  const injectMax = boundedInt(cfg.injectMaxChars, 0, 0, 20000);
  if (injectMax > 0) {
    let budget = 0;
    const kept = [];
    for (const rec of recalledRecords) {
      budget += rec.content.length;
      if (budget > injectMax && kept.length) break;
      kept.push(rec);
    }
    recalledRecords = kept;
  }
  const p1_act = recalledRecords.map(d => d.content);
  const usedWords = [...new Set(picked.flatMap(d => d.hits.map(h => h.word)))];
  if (usedWords.length) recordUsage(usedWords);

  const allTokens = r.n1?.contextTokens ?? [];
  const inputKept = allTokens.filter(t => !t.filtered);
  const inputFiltered = allTokens.filter(t => t.filtered);
  const filterByReason = {};
  for (const token of inputFiltered) {
    const reason = token.reason || '?';
    filterByReason[reason] = (filterByReason[reason] || 0) + 1;
  }
  const serviceTimings = {
    memoryLoadMs,
    pipelineCallMs,
    totalBeforeSerializeMs: +(performance.now() - requestStarted).toFixed(1),
  };

  // 面向用户/P9 的最小反馈包：报告事实与漏斗，不替用户猜 gold，也不把“有输出”冒充召回率。
  const unitCounts = {};
  for (const unit of r.n0?.units ?? []) unitCounts[unit.type] = (unitCounts[unit.type] || 0) + 1;
  const availableUserMessages = pipelineInput.messages.filter(m => m?.role === 'user' && m.content).length;
  const availableDataRecords = dataRecall ? (pipelineInput.dataRecords?.length ?? 0) : 0;
  const expectedUserContext = Math.min(pipelineInput.contextCount, availableUserMessages);
  const expectedDataContext = Math.min(pipelineInput.dataCount, availableDataRecords);
  const contractIssues = [];
  if ((unitCounts.user_current ?? 0) !== 1) contractIssues.push({ code: 'P1_CURRENT_INPUT_COUNT_INVALID', expected: 1, actual: unitCounts.user_current ?? 0 });
  if ((unitCounts.user_context ?? 0) !== expectedUserContext) contractIssues.push({ code: 'P1_USER_CONTEXT_UNDERFILLED', expected: expectedUserContext, actual: unitCounts.user_context ?? 0, requested: pipelineInput.contextCount, available: availableUserMessages });
  if ((unitCounts.ai_output ?? 0) !== 0) contractIssues.push({ code: 'P1_AI_OUTPUT_CONTEXT_FORBIDDEN', expected: 0, actual: unitCounts.ai_output ?? 0 });
  if ((unitCounts.data ?? 0) !== expectedDataContext) contractIssues.push({ code: 'P1_DATA_CONTEXT_UNDERFILLED', expected: expectedDataContext, actual: unitCounts.data ?? 0, requested: pipelineInput.dataCount, available: availableDataRecords });
  const feedbackPacket = {
    schema: 'p1_feedback_v1',
    scope: fourLayerScope(req, windowLayer),
    input: String(req.inputText ?? '').slice(0, 1000),
    inputContract: {
      ok: contractIssues.length === 0,
      requestedUserContext: pipelineInput.contextCount,
      availableUserMessages,
      selectedUserContext: unitCounts.user_context ?? 0,
      selectedCurrentUser: unitCounts.user_current ?? 0,
      selectedAiOutput: unitCounts.ai_output ?? 0,
      requestedDataContext: pipelineInput.dataCount,
      availableDataRecords,
      selectedDataContext: unitCounts.data ?? 0,
      unitCounts,
      issues: contractIssues,
    },
    funnel: {
      scannedDocuments: mem.docs?.length ?? 0,
      node0Units: r.n0?.units?.length ?? 0,
      node0Excluded: r.n0?.units?.filter(unit => unit.excluded).length ?? 0,
      node1Tokens: allTokens.length,
      node1Kept: inputKept.length,
      node1Filtered: inputFiltered.length,
      node1FilterByReason: filterByReason,
      node2Pool: r.n2?.pool?.length ?? 0,
      node3Scored: r.n3?.scored?.length ?? 0,
      node4EligibleRanked: r.n4?.ranked?.filter(isOutputEligible)?.length ?? 0,
      selectedBeforeCharacterBudget: picked.length,
      returnedAfterCharacterBudget: recalledRecords.length,
      characterBudget: boundedInt(cfg.injectMaxChars, 0, 0, 20000),
      characterBudgetDropped: Math.max(0, picked.length - recalledRecords.length),
    },
    topResults: recalledRecords.map(record => ({
      recordId: record.recordId,
      layer: record.layer,
      sourceRel: record.sourceRel,
      score: record.score,
      matchedTerms: record.matchedTerms,
      contentPreview: record.content.slice(0, 160),
    })),
    qualityBoundary: 'No Recall@K claim without user-confirmed expected records or goldRecordIds.',
    userFeedback: {
      expectedRecall: '',
      missedRecall: '',
      wrongRecall: '',
      notes: '',
    },
  };

  // 实验储存(凛倾0801: "现在是实验功能,需要进行展示和问题收集,单独储存不存对话")
  // 每次召回结果独立落盘 JSONL，按 stateRoot 的 username×charName×chatId×mode 四元作用域隔离；
  // config.experimentLog=true(默认开) 可在前端面板关，不污染宿主记忆或对话数据。
  let experimentLog = { enabled: cfg.experimentLog !== false, written: false, error: null };
  if (cfg.experimentLog !== false && recalledRecords.length > 0) {
    try {
      const expDir = join(req.stateRoot, 'experiments');
      if (!existsSync(expDir)) mkdirSync(expDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const entry = {
        ts: new Date().toISOString(),
        mode: windowLayer,
        scope: {
          username: String(req.username ?? ''),
          charName: String(req.charName ?? ''),
          chatId: String(req.chatId ?? ''),
          mode: windowLayer,
        },
        input: String(req.inputText ?? '').slice(0, 500),
        contextWords: r.n1?.contextTokens?.filter(t => !t.filtered).map(t => t.word).slice(0, 30) ?? [],
        expansionTop: r.n3?.scored?.slice(0, 10).map(s => ({ word: s.word, sources: s.sources, score: s.score })) ?? [],
        recalled: recalledRecords,
        memoryStats: mem.layerCounts,
        poolSize: r.n2?.pool?.length ?? 0,
        feedbackPacket,
        ms: +(performance.now() - requestStarted).toFixed(1),
      };
      writeFileSync(join(expDir, `p1_exp_${today}.jsonl`), JSON.stringify(entry) + '\n', { flag: 'a' });
      experimentLog.written = true;
    } catch (error) {
      experimentLog.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
    }
  }

  return {
    success: true,
    engine: 'p1v2_whitebox_stdio',
    p1_act,
    recalledRecords,
    directionWords,
    feedbackPacket,
    v5: null,
    trace: {
      request: requestTrace(req, r.n0, { dataRecall, queue }),
      serviceTimings,
      node1: node1Trace(r.n0, r.n1),
      tokenizeCache: tokenizeCacheReport(),
      pipelineTimings: r.timings ?? null,
      recall: {
        // node1: 分词+过滤
        totalTokens: allTokens.length,
        inputWords: inputKept.map(t => t.word),
        currentInputWords: inputKept.filter(t => t.unitType === 'user_current').map(t => t.word),
        contextWords: inputKept.filter(t => t.unitType === 'user_context').map(t => t.word),
        dataWords: inputKept.filter(t => t.unitType === 'data').map(t => t.word),
        filteredCount: inputFiltered.length,
        filterByReason,
        // node2: 发散+二次过滤
        rawPoolCount: r.n2?.pool?.length ?? 0,
        swowPool: (r.n2?.pool ?? []).map(p => ({ word: p.word, sources: p.sources, strength: p.strength, resonance: p.resonance, via: p.via })),
        secondPassRemoved: (r.n2?.removedBySecondPass ?? []).map(x => ({ word: x.word, reason: x.reason })),
        mechanisms: (r.n2?.mechanisms ?? []).map(m => ({
          name: m.mechanism,
          produced: m.produced,
          status: m.status ?? null,
          errors: (Array.isArray(m.errors) ? m.errors : []).map(error => ({
            code: error?.code ?? 'E_P1_NODE2_DEGRADED',
            mechanism: error?.mechanism ?? m.mechanism ?? null,
            resource: error?.resource ?? null,
            message: error?.message ?? String(error ?? 'unknown Node2 mechanism degradation'),
            details: error?.details && typeof error.details === 'object' ? error.details : null,
          })),
          note: m.note ?? null,
        })),
        node2: {
          status: r.n2?.status === 'ok' ? 'ok' : 'degraded',
          errors: (Array.isArray(r.n2?.errors) ? r.n2.errors : []).map(error => ({
            code: error?.code ?? 'E_P1_NODE2_DEGRADED',
            mechanism: error?.mechanism ?? null,
            resource: error?.resource ?? null,
            message: error?.message ?? String(error ?? 'unknown Node2 degradation'),
            details: error?.details && typeof error.details === 'object' ? error.details : null,
          })),
        },
        // node3: BLQ预筛+NB300+WN+BLQ终筛
        blqDropped: (r.n3?.droppedByBlq ?? []).map(d => ({ word: d.word, score: d.score, reason: d.dropReason })),
        nbDropped: (r.n3?.droppedByNb ?? []).map(d => ({ word: d.word, cos: d.factors?.nbCos })),
        wnDropped: (r.n3?.droppedByWn ?? []).map(d => ({ word: d.word, cos: d.factors?.nbCos, wn: d.factors?.wnSim })),
        nbAvailable: r.n3?.nbAvailable ?? false,
        scoredPool: buildScoredPoolTrace(r.n3?.scored),
        scoredPoolLimit: SCORED_POOL_TRACE_LIMIT,
        scoredPoolTruncated: (r.n3?.scored?.length ?? 0) > SCORED_POOL_TRACE_LIMIT,
        scoredCount: r.n3?.scored?.length ?? 0,
        dataRecall: {
          enabled: dataRecall,
          memoryScan: dataRecall,
          reason: memoryReason,
          scope: fourLayerScope(req, windowLayer),
          requestScope: fourLayerScope(req, windowLayer),
          sourceScope: mem.sourceScope,
          indexScope: mem.indexScope,
          chatContextBound: mem.chatContextBound,
        },
        memoryScan: dataRecall,
        memoryReason,
        // node4: 匹配排序
        dedup: {
          nbAvailable: r.n4?.nbDedupAvailable ?? false,
          why: r.n4?.nbDedupWhy ?? null,
          pairCount: r.n4?.nbDedupPairCount ?? 0,
          coveredPairs: r.n4?.nbDedupCoveredPairs ?? 0,
          removed: (r.n4?.dedupTrace ?? []).map(d => ({
            removed: d.removed, kept: d.kept, rule: d.rule,
            pairCos: d.pairCos ?? null, keptAnchorCos: d.cosA ?? null, removedAnchorCos: d.cosB ?? null,
          })),
        },
        rankedCount: r.n4?.ranked?.filter(isOutputEligible)?.length ?? 0,
        ranking: rankingTrace(r.n4),
        userVocab: {
          files: pipelineInput.userVocab.files,
          entries: pipelineInput.userVocab.entries.length,
          matches: (r.n2?.pool ?? [])
            .filter(item => Array.isArray(item.userVocabMatches) && item.userVocabMatches.length)
            .map(item => ({ word: item.word, matches: item.userVocabMatches })),
        },
        storageDiagnostics: r.storageDiagnostics ?? [],
        experimentLog,
        index: fourLayerIndexTrace(r.n4?.indexCache, req, cfg, windowLayer, mem),
        anchors: r.n1?.timeAnchors ?? [],
      },
    },
    memory: {
      memoryScan: dataRecall,
      reason: memoryReason,
      scope: fourLayerScope(req, windowLayer),
      requestScope: fourLayerScope(req, windowLayer),
      sourceScope: mem.sourceScope,
      indexScope: mem.indexScope,
      chatContextBound: mem.chatContextBound,
      layerCounts: mem.layerCounts,
      why: mem.why,
      cacheHit: mem.cacheHit,
      storageDiagnostics: r.storageDiagnostics ?? mem.diagnostics ?? [],
    },
    config: cfgResult,
    whitebox: req.whitebox
      ? `${renderFullWhitebox(r)}\n\n══════════ P9 用户反馈包（p1_feedback_v1） ══════════\n${JSON.stringify(feedbackPacket, null, 2)}`
      : undefined,
  };
  } catch (error) {
    return failureEnvelope(req, stage, error, { dataRecall, queue });
  }
}

function requireWarmResource(condition, code, message, details = null) {
  if (condition) return;
  throw Object.assign(new Error(message), { code, details });
}

/**
 * 专用资源预热，不构造用户输入、不读记忆、不写 novelty usage/experiment/run log。
 * 集群进程由 Python owner 先行拉起；本动作负责让各懒加载资源完成第一次真实初始化。
 */
async function handleWarmup(req, queue) {
  const startedAt = Date.now();
  const cfgResult = applyConfig(req.config ?? {});
  const resources = {};

  let t0 = Date.now();
  const tokenize = await httpCall('tokenize', 'warmup', {}, 45000);
  requireWarmResource(
    tokenize?._cluster_err !== true
      && tokenize?.success === true
      && tokenize?.readyForRecall === true
      && tokenize?.ready === true,
    tokenize?.code || 'P1_WARMUP_TOKENIZER_FAILED',
    tokenize?.error || 'tokenizer/ONNX warmup did not reach an available state',
    tokenize?.details || tokenize?.resources || tokenize,
  );
  resources.tokenizer = {
    ready: true,
    elapsedMs: Date.now() - t0,
    loadMs: tokenize.ms ?? null,
    provider: tokenize.provider ?? null,
    resources: tokenize.resources ?? null,
  };

  t0 = Date.now();
  const vector = await httpCall('vector', 'warmup', {}, 90000);
  requireWarmResource(
    vector?._cluster_err !== true
      && vector?.success === true
      && vector?.readyForRecall === true
      && vector?.ready === true,
    vector?.code || 'P1_WARMUP_VECTOR_FAILED',
    vector?.error || 'Numberbatch/WordNet warmup unavailable',
    vector?.details || vector?.resources || vector,
  );
  resources.vector = {
    ready: true,
    elapsedMs: Date.now() - t0,
    loadMs: vector.ms ?? null,
    provider: vector.provider ?? null,
    resources: vector.resources ?? null,
  };

  t0 = Date.now();
  const llmtok = await httpCall('llmtok', 'warmup', {}, 45000);
  requireWarmResource(
    llmtok?._cluster_err !== true
      && llmtok?.success === true
      && llmtok?.readyForRecall === true
      && llmtok?.ready === true,
    llmtok?.code || 'P1_WARMUP_GIGATOKEN_FAILED',
    llmtok?.error || llmtok?.provider || 'Gigatoken warmup unavailable',
    llmtok?.details || llmtok?.resources || llmtok,
  );
  resources.gigatoken = {
    ready: true,
    elapsedMs: Date.now() - t0,
    loadMs: llmtok.ms ?? null,
    provider: llmtok.provider ?? null,
    resources: llmtok.resources ?? null,
  };

  // Node1 本地静态词表也属于召回就绪条件。resourceReport 仅触发 loader/cache，
  // 不构造用户文本、不运行分词和候选算法；缺失会直接让 warmup 失败而不是静默带病运行。
  t0 = Date.now();
  resources.node1Local = {
    ready: true,
    elapsedMs: null,
    resources: resourceReport(),
  };
  resources.node1Local.elapsedMs = Date.now() - t0;

  t0 = Date.now();
  let localResources;
  try {
    localResources = warmLocalResources2();
  } catch (error) {
    throw Object.assign(new Error(`Node2-4 local resource warmup failed: ${error?.message ?? String(error)}`), {
      code: 'P1_WARMUP_LOCAL_RESOURCES_FAILED',
      details: {
        items: error?.details?.items ?? null,
        excluded: ['domainWords:data-shards'],
        causeCode: error?.code ?? null,
        causeDetails: error?.details ?? null,
      },
    });
  }
  requireWarmResource(
    localResources?.available === true,
    'P1_WARMUP_LOCAL_RESOURCES_FAILED',
    'Node2-4 local resources did not reach an available state',
    { items: localResources?.items ?? null, excluded: localResources?.excluded ?? [] },
  );
  resources.node2To4Local = {
    ready: true,
    elapsedMs: Date.now() - t0,
    totalMs: localResources.totalMs ?? null,
    items: localResources.items,
    excluded: localResources.excluded,
  };

  return {
    success: true,
    action: 'warmup',
    readyForRecall: true,
    ms: Date.now() - startedAt,
    queue: queueTrace(queue),
    resources,
    config: cfgResult,
  };
}

// applyConfig/PARAMS 与 novelty usage 目录都是模块级可变状态。因此 runP1 的整个
// 生命周期必须和 clearCaches 在同一条 FIFO 上互斥，不能只串行 stdin 写入。
let _queueTail = Promise.resolve();
let _queueNextSequence = 1;
let _queuePending = 0;
let _queueActiveSequence = null;

function queueState() {
  return {
    busy: _queuePending > 0,
    pending: _queuePending,
    activeSequence: _queueActiveSequence,
    nextSequence: _queueNextSequence,
  };
}

function enqueueExclusive(work) {
  const queue = {
    sequence: _queueNextSequence++,
    ahead: _queuePending,
    enqueuedAt: Date.now(),
    startedAt: null,
  };
  _queuePending += 1;
  const run = async () => {
    queue.startedAt = Date.now();
    _queueActiveSequence = queue.sequence;
    try {
      return await work(queue);
    } finally {
      _queuePending -= 1;
      _queueActiveSequence = null;
    }
  };
  const result = _queueTail.then(run, run);
  _queueTail = result.then(() => undefined, () => undefined);
  return result;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); }
  catch { return out({ success: false, error: 'bad json request' }); }
  const rid = req._rid;
  const reply = (obj) => out(rid ? { ...obj, _rid: rid } : obj);
  try {
    if (req.action === 'health') {
      return reply({
        ok: true,
        service: RUNTIME_CONTRACT.stdioService,
        contract: RUNTIME_CONTRACT.id,
        uptimeSec: Math.round((Date.now() - _started) / 1000),
        queue: queueState(),
      });
    }
    if (req.action === 'clearCaches') {
      return enqueueExclusive(async (queue) => ({
          success: true,
          tier: String(req.tier ?? 'light'),
          queue: queueTrace(queue),
          report: {
            memory: clearMemoryCache(),
            rank: clearRankCaches(),
            tokenize: clearTokenizeCache(),
          },
        }))
        .then(reply)
        .catch(e => reply(failureEnvelope(req, 'clear_caches', e)));
    }
    if (req.action === 'warmup') {
      return enqueueExclusive(queue => handleWarmup(req, queue))
        .then(reply)
        .catch(e => reply(failureEnvelope(req, 'warmup', e)));
    }
    if (req.action === 'runP1') {
      return enqueueExclusive(queue => handleRunP1(req, queue))
        .then(reply)
        .catch(e => reply(failureEnvelope(req, 'stdio_dispatch', e)));
    }
    return reply({ success: false, error: `unknown action: ${req.action}` });
  } catch (e) {
    return reply({ success: false, p1_act: [], error: `${e?.name}: ${e?.message}` });
  }
});

process.stdin.on('end', () => {
  _queueTail.finally(() => process.exit(0));
});
out({
  ready: true,
  service: RUNTIME_CONTRACT.stdioService,
  contract: RUNTIME_CONTRACT.id,
}); // 启动握手(py 侧等此行确认就绪)
