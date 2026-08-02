// p1_service_stdio.mjs — P1 新管线常驻子进程(行协议 JSONL)
//
// 功能链: p1_server.py(HTTP 服务壳,002 拍板可插拔架构) spawn 本进程(一次) →
//   stdin 每行一个 JSON 请求 → runPipeline → stdout 每行一个 JSON 响应
// why 常驻: 词库(BCC/meld/userdict)与 HanLP 模型加载秒级,spawnSync 每请求冷启不可用;
//   常驻进程加载一次,后续请求毫秒-百毫秒级。py 壳负责 config/词库管理 endpoint,本进程只跑管线。
//
// 行协议:
//   → {action:'health'}                          ← {ok, uptimeSec, resources}
//   → {action:'runP1', inputText, chatHistory, mode, username, charName, config, whitebox?}
//   ← {success, p1_act, recalledRecords:[{layer,matchedTerms,content}], directionWords, v5, whitebox?, error?}
//   响应形状与 p1_server.py /runP1 返回块同 schema(p1Bridge/前端消费方零改动)

import readline from 'node:readline';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPipeline, renderFullWhitebox } from './pipeline.mjs';
import { applyConfig } from './config_map.mjs';
import { loadThreeLayerMemory } from './storage_read.mjs';
import { recordUsage, setUsageDir } from './node3_score.mjs';

const _started = Date.now();
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

async function handleRunP1(req) {
  const cfg = req.config ?? {};
  const cfgResult = applyConfig(cfg);

  // 储存: 三层记忆按角色卡隔离读取(layer 标注透传出口)
  // 角色卡级隔离: novelty_usage 存到角色卡 memory/ 下
  const _memDir = join(cfg.dataRoot || '.', req.username || '_default', 'chars', req.charName || '_global', 'memory');
  setUsageDir(_memDir);
  const mem = loadThreeLayerMemory(req.username, req.charName, cfg.dataRoot, String(req.mode ?? 'chat'), {
    includeMarkdown: cfg.includeMarkdown,
    indexCacheMax: cfg.indexCacheMax,
    dataCount: cfg.dataCount,
  });
  const docs = mem.docs;

  const r = await runPipeline({
    currentUserText: String(req.inputText ?? ''),
    messages: Array.isArray(req.chatHistory) ? req.chatHistory : [],
    docs,
    dataRecords: mem.recentDocs ?? [],
    mode: String(req.mode ?? 'chat'),
    ctxWordsPerUnit: cfg.ctxWordsPerUnit,
    fusion: cfg.fusion,
    mechanisms: cfg.mechDisable ? { disable: String(cfg.mechDisable).split(',').map(s => s.trim()).filter(Boolean) } : undefined,
    layerWeights: cfg.layerWeightHot != null ? { hot: Number(cfg.layerWeightHot) || 1.0, warm: Number(cfg.layerWeightWarm) || 0.85, cold: Number(cfg.layerWeightCold) || 0.7 } : undefined,
    recencyDecayBase: Number(cfg.recencyDecayBase) || 0.995,
  });

  const topRecall = Math.max(1, Math.min(50, Number(cfg.recordTopK) || 5));
  const snippetMax = Math.max(40, Math.min(2000, Number(cfg.snippetMaxChars) || 240));
  const picked = r.n4.ranked.filter(d => d.final > 0 && !d.selfSource).slice(0, topRecall);
  let recalledRecords = picked.map(d => ({
    layer: d.layer || String(d.id).split('_')[0] || null,
    sourceRel: d.sourceRel || null,
    sourceType: d.sourceType || null,
    matchedTerms: d.hits.map(h => h.word),
    content: d.text.length > snippetMax ? d.text.slice(0, snippetMax) + '…' : d.text,
    score: d.final,
  }));
  // injectMaxChars: 注入总字符上限(0=不限, 与 Python p1_node0_data_recall.py 对齐)
  const injectMax = Math.max(0, Math.min(20000, Number(cfg.injectMaxChars) || 0));
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

  // 实验储存(凛倾0801: "现在是实验功能,需要进行展示和问题收集,单独储存不存对话")
  // 每次召回结果独立落盘 JSONL,按角色卡隔离——用于离线分析正确率/问题追溯,不污染对话数据
  // config.experimentLog=true(默认开) 可在前端面板关;路径跟随 dataRoot 按角色卡走
  if (cfg.experimentLog !== false && recalledRecords.length > 0) {
    try {
      const expDir = join(cfg.dataRoot || '.', req.username || '_default', 'chars', req.charName || '_global', 'memory', 'p1_experiment_log');
      if (!existsSync(expDir)) mkdirSync(expDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const entry = {
        ts: new Date().toISOString(),
        mode: String(req.mode ?? 'chat'),
        input: String(req.inputText ?? '').slice(0, 500),
        contextWords: r.n1?.contextTokens?.filter(t => !t.filtered).map(t => t.word).slice(0, 30) ?? [],
        expansionTop: r.n3?.scored?.slice(0, 10).map(s => ({ word: s.word, sources: s.sources, score: s.score })) ?? [],
        recalled: recalledRecords,
        memoryStats: mem.layerCounts,
        poolSize: r.n2?.pool?.length ?? 0,
        ms: Date.now() - _started,
      };
      writeFileSync(join(expDir, `p1_exp_${today}.jsonl`), JSON.stringify(entry) + '\n', { flag: 'a' });
    } catch { /* 实验日志写失败不影响主链 */ }
  }

  const allTokens = r.n1?.contextTokens ?? [];
  const inputKept = allTokens.filter(t => !t.filtered);
  const inputFiltered = allTokens.filter(t => t.filtered);
  const filterByReason = {};
  for (const t of inputFiltered) { const r2 = t.reason || '?'; filterByReason[r2] = (filterByReason[r2] || 0) + 1; }
  return {
    success: true,
    engine: 'p1v2_whitebox_stdio',
    p1_act,
    recalledRecords,
    directionWords: [],
    v5: null,
    trace: {
      recall: {
        // node1: 分词+过滤
        totalTokens: allTokens.length,
        inputWords: inputKept.map(t => t.word),
        filteredCount: inputFiltered.length,
        filterByReason,
        // node2: 发散+二次过滤
        rawPoolCount: r.n2?.pool?.length ?? 0,
        swowPool: (r.n2?.pool ?? []).map(p => ({ word: p.word, sources: p.sources, strength: p.strength, resonance: p.resonance, via: p.via })),
        secondPassRemoved: (r.n2?.removedBySecondPass ?? []).map(x => ({ word: x.word, reason: x.reason })),
        mechanisms: (r.n2?.mechanisms ?? []).map(m => ({ name: m.mechanism, produced: m.produced, note: m.note })),
        // node3: BLQ预筛+NB300+WN+BLQ终筛
        blqDropped: (r.n3?.droppedByBlq ?? []).map(d => ({ word: d.word, score: d.score, reason: d.dropReason })),
        nbDropped: (r.n3?.droppedByNb ?? []).map(d => ({ word: d.word, cos: d.factors?.nbCos })),
        wnDropped: (r.n3?.droppedByWn ?? []).map(d => ({ word: d.word, cos: d.factors?.nbCos, wn: d.factors?.wnSim })),
        nbAvailable: r.n3?.nbAvailable ?? false,
        scoredPool: (r.n3?.scored ?? []).map(s => ({ word: s.word, score: s.score, sources: s.sources, resonance: s.resonance, cos: s.factors?.nbCos, gold: s.factors?.goldilocks?.zone })),
        scoredCount: r.n3?.scored?.length ?? 0,
        // node4: 匹配排序
        rankedCount: r.n4?.ranked?.filter(d => d.final > 0 && !d.selfSource)?.length ?? 0,
        anchors: r.n1?.timeAnchors ?? [],
      },
    },
    memory: { layerCounts: mem.layerCounts, why: mem.why },
    config: cfgResult,
    whitebox: req.whitebox ? renderFullWhitebox(r) : undefined,
  };
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
      return reply({ ok: true, service: 'p1v2-stdio', uptimeSec: Math.round((Date.now() - _started) / 1000) });
    }
    if (req.action === 'runP1') return handleRunP1(req).then(reply).catch(e => reply({ success: false, p1_act: [], error: e?.message }));
    return reply({ success: false, error: `unknown action: ${req.action}` });
  } catch (e) {
    return reply({ success: false, p1_act: [], error: `${e?.name}: ${e?.message}` });
  }
});

process.stdin.on('end', () => process.exit(0));
out({ ready: true, service: 'p1v2-stdio' }); // 启动握手(py 侧等此行确认就绪)
