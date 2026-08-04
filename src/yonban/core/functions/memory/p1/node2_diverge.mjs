// node2_diverge.mjs — 发散: 机制并行 → 汇池(自驱动召回新管线 第3节)
//
// 设计来源: P1_新管线设计_算法标注版.md §发散
// 架构铁律: "P1应该是机制并行, 不是轴并行. 每个机制独立产出"(A05 §七 凛倾原话)
//   每个机制独立跑,产出带 source 标签汇入同一 poolMap;同词多机制命中 → sources[] 追加,
//   strength 累加(CombSUM 加性, run27 +62% 实证);跨机制共振(≥2 机制)=高置信
// 红线: Synonym=0.05 / Antonym=0.01 / IsA=0.05 (run23 同义扩散 lccc -55% 铁证,禁改)
//
// 功能链: node1 有效token → 【本模块: 模式路由→机制并行→汇池→二次过滤】 → node3 标注打分

import {
  loadSwowZh, loadSwowEn, loadConceptnetZh, loadConceptnetEn, loadCilin,
  loadAtomic, loadAbbrCode, loadSeAbbr, loadComputerese, loadAiTerms, loadGlossaries,
  loadBasicTech, loadGlossaryNouns, loadDomainWords,
  loadCfnLex, loadThuoclIt, loadThuoclAnimal, loadDomainWordsIt, loadMoetypeAcg,
} from './resources2.mjs';
import { loadStopwordsCN, bccFreq, loadMeldSch } from './resources.mjs';
import { bridgeTokenize, PARAMS as N1_PARAMS } from './node1_tokenize.mjs';
import { httpCall } from './cluster.mjs';
import { readFileSync } from 'node:fs';
import { findResource } from './p1_resdir.mjs';

const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const envI = (n, d) => { const v = parseInt(process.env[n], 10); return Number.isFinite(v) ? v : d; };
const envF = (n, d) => { const v = parseFloat(process.env[n]); return Number.isFinite(v) ? v : d; };

function mechanismDiagnostic(error, mechanism, fallbackCode = 'E_P1_MECHANISM_UNAVAILABLE') {
  const code = error?.code ?? fallbackCode;
  const rawMessage = error?.message ?? String(error ?? 'unknown mechanism failure');
  const message = rawMessage.includes(`[${code}]`) ? rawMessage : `[${code}] ${rawMessage}`;
  return {
    code,
    mechanism,
    message,
    ...(error?.resource ? { resource: error.resource } : {}),
    ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
  };
}

function optionalResourceDiagnostic(resource, result) {
  const why = result?.why ?? 'resource unavailable without diagnostic';
  return {
    code: 'E_P1_OPTIONAL_RESOURCE_UNAVAILABLE',
    resource,
    message: `[E_P1_OPTIONAL_RESOURCE_UNAVAILABLE] ${resource}: ${why}`,
  };
}

function resourceAwareResult(candidates, resources, extra = {}) {
  const unavailable = resources.filter(([, result]) => !result?.available);
  const errors = unavailable.map(([resource, result]) => optionalResourceDiagnostic(resource, result));
  const resourceNote = errors.map(error => error.message).join('; ');
  const note = [extra.note, resourceNote].filter(Boolean).join('; ') || null;
  return {
    candidates,
    ...extra,
    note,
    status: unavailable.length
      ? (resources.some(([, result]) => result?.available) ? 'degraded' : 'unavailable')
      : 'available',
    errors,
  };
}

export const PARAMS = {
  // SWOW 每词取前 K 联想 [待实验定→白盒定];旧架构判"半死"是 fallback-only 路径,新管线直接进池是活参数
  SWOW_TOPK: clampI(envI('P1_N2_SWOW_TOPK', 6), 1, 30),
  // 多词交集定位 [白盒0801定档]: 设计初值2(≥2词共同联想)在真实输入下中文SWOW仅产出2候选=机制饿死,
  // 机制废了就无共振可投,与机制并行架构冲突 → 降1;多词共振优势由池 resonance 自然体现
  SWOW_MIN_SUPPORT_ZH: clampI(envI('P1_N2_SWOW_MINSUP_ZH', 1), 1, 5),
  SWOW_MIN_SUPPORT_EN: 1,
  // ConceptNet 每词每 rel 取前 K
  CN_TOPK: clampI(envI('P1_N2C_CN_TOPK', 10), 1, 50),
  // 词林层级强度: L4同段(=行)最强;词林不做编码距离类比(凛倾评价"形而上学")
  CILIN_STRENGTH_SAME_ROW: 0.5,
  // L3=同小类/L2=同中类 层级强度(设计要求层级扩展;标注引用的PATH_QUALITY=1.4经全旧链grep查无出处,强度[白盒定])
  CILIN_STRENGTH_L3: 0.3,
  CILIN_STRENGTH_L2: 0.15,
  CILIN_MAX_PER_WORD: 8,
  // [白盒定档0801] 真实459条: L2同中类扩出 职业/工作/语言 via 话 纯噪声霸屏 → 默认关(env可开);L3收窄
  CILIN_MAX_L3: clampI(envI('P1_CILIN_MAX_L3', 2), 0, 10),
  CILIN_MAX_L2: clampI(envI('P1_CILIN_MAX_L2', 0), 0, 10),
  // ATOMIC 每词取 K 条事件推理
  ATOMIC_TOPK: 6,
  // CFN 每个 frame 取前 K 个同框架词(work 模式)
  CFN_MAX_PER_FRAME: clampI(envI('P1_CFN_MAX_FRAME', 10), 1, 50),
  CFN_STRENGTH: 0.4,
  // 英文 ConceptNet Synonym/IsA 权重覆盖(0731 A/B 三档定档 0.3)
  EN_RELW: 0.3,
  // ConceptNet edge weight 归一化除数: CN 原始 weight 常见 0.5-4,除以此值后 min(1,w/D) 压到 [0,1] 域
  // 算法推导: 中位数≈2,D=2 使中位权重映射到 1.0 附近,max(1,...) 截断高值(无 env: 改此值需理解 CN 量纲)
  CN_WEIGHT_DIVISOR: 2,
  // ATOMIC 事件推理产出的固定 strength [待实验定: 经验起步值,无实验数据]
  ATOMIC_STRENGTH: envF('P1_ATOMIC_STRENGTH', 0.4),
  // CN 关系权重截断阈值: relW < 此值的关系不产出候选
  // 当前 0.05 = Synonym/IsA 的权重(刚好不截断);Antonym 0.01 被截断
  // 警告: 此值与 REL_WEIGHTS 红线耦合,调大会截断 Synonym/IsA,调小会放行 Antonym
  CN_RELW_FLOOR: envF('P1_CN_RELW_FLOOR', 0.05),
};

// ConceptNet 关系权重(p1_pool 定档表;红线 3 项禁改)
export const REL_WEIGHTS = {
  Causes: 0.9, MotivatedByGoal: 0.8, CapableOf: 0.7, UsedFor: 0.6,
  HasSubevent: 0.5, CausesDesire: 0.5, HasProperty: 0.5,
  AtLocation: 0.4, HasA: 0.3, PartOf: 0.3,
  RelatedTo: 0.1, IsA: 0.05, Synonym: 0.05, Antonym: 0.01, // ← 红线: run23 -55%
};

// ---- 机制A: SWOW 自由联想(中英两套独立网络) ----
function swowDiverge(words, lang) {
  const res = lang === 'zh' ? loadSwowZh() : loadSwowEn();
  const resource = lang === 'zh' ? 'swowZh' : 'swowEn';
  if (!res.available) return resourceAwareResult([], [[resource, res]]);
  const swow = res.data;
  const minSupport = words.length > 1
    ? (lang === 'zh' ? PARAMS.SWOW_MIN_SUPPORT_ZH : PARAMS.SWOW_MIN_SUPPORT_EN)
    : 1;
  // 每个输入词取 topK 联想,统计 support(几个输入词共同联想到)
  const hit = new Map(); // word → {strength合计, support集合, via[]}
  for (const w of words) {
    const assoc = swow.get(w);
    if (!assoc) continue;
    for (const { word: cand, strength } of assoc.slice(0, PARAMS.SWOW_TOPK)) {
      if (!hit.has(cand)) hit.set(cand, { strength: 0, support: new Set(), via: [] });
      const h = hit.get(cand);
      h.strength += strength;
      h.support.add(w);
      h.via.push(w);
    }
  }
  const candidates = [];
  for (const [word, h] of hit) {
    if (h.support.size < minSupport) continue;
    candidates.push({
      word,
      source: lang === 'zh' ? 'swow_zh' : 'swow_en',
      strength: h.strength / h.via.length, // 平均联想强度,support 优势体现在共振加成
      support: h.support.size,
      via: [...h.support],
    });
  }
  return resourceAwareResult(candidates, [[resource, res]]);
}

// ---- 机制B: ConceptNet 关系发散 ----
function conceptnetDiverge(words, lang) {
  const res = lang === 'zh' ? loadConceptnetZh() : loadConceptnetEn();
  const resource = lang === 'zh' ? 'conceptnetZh' : 'conceptnetEn';
  if (!res.available) return resourceAwareResult([], [[resource, res]]);
  const inv = res.data;
  const candidates = [];
  for (const w of words) {
    const edges = typeof inv.get === 'function'
      ? (inv.get(w) ?? inv.get(w.toLowerCase()))
      : (inv[w] ?? inv[w.toLowerCase()]);
    if (!edges) continue;
    const perRel = new Map();
    for (const [relRaw, target, weight] of edges) {
      const rel = relRaw.replace(/~$/, '');
      let relW = REL_WEIGHTS[rel] ?? 0;
      // 英文 Synonym/IsA 覆盖为 0.3(0731 定档: 义项修复 bug→defect/buffer)
      if (lang === 'en' && (rel === 'Synonym' || rel === 'IsA')) relW = PARAMS.EN_RELW;
      if (relW < PARAMS.CN_RELW_FLOOR) continue; // Antonym 0.01 等极低权重不产出候选(红线语义: 存在但近禁用)
      const n = perRel.get(rel) ?? 0;
      if (n >= PARAMS.CN_TOPK) continue;
      perRel.set(rel, n + 1);
      candidates.push({
        word: target,
        source: lang === 'zh' ? 'conceptnet' : 'conceptnet_en',
        rel,
        strength: relW * Math.min(1, weight / PARAMS.CN_WEIGHT_DIVISOR), // ConceptNet weight 常见 0.5-4,压到 [0,1] 域
        via: [w],
      });
    }
  }
  return resourceAwareResult(candidates, [[resource, res]]);
}

// ---- 机制C: 词林同段同义扩展(仅 chat/airp 中文) ----
function cilinDiverge(words) {
  const res = loadCilin();
  if (!res.available) return resourceAwareResult([], [['cilin', res]]);
  const { wordToCodes, codeToWords, smallToWords, midToWords } = res.data;
  const candidates = [];
  for (const w of words) {
    const codes = wordToCodes.get(w);
    if (!codes) continue;
    let taken = 0;
    const seen = new Set([w]);
    for (const code of codes) {
      if (!code.endsWith('=')) continue; // 只用 = 同义行,#相关 @独立 不用
      for (const cand of codeToWords.get(code) ?? []) {
        if (seen.has(cand) || taken >= PARAMS.CILIN_MAX_PER_WORD) continue;
        seen.add(cand); taken++;
        candidates.push({ word: cand, source: 'cilin', level: 'L4', strength: PARAMS.CILIN_STRENGTH_SAME_ROW, via: [w] });
      }
      // 层级扩展(设计: 同大类L3+同中类L2;不做编码距离类比)
      let l3 = 0;
      for (const cand of smallToWords.get(code.slice(0, 4)) ?? []) {
        if (seen.has(cand) || l3 >= PARAMS.CILIN_MAX_L3) continue;
        seen.add(cand); l3++;
        candidates.push({ word: cand, source: 'cilin', level: 'L3', strength: PARAMS.CILIN_STRENGTH_L3, via: [w] });
      }
      let l2 = 0;
      for (const cand of midToWords.get(code.slice(0, 2)) ?? []) {
        if (seen.has(cand) || l2 >= PARAMS.CILIN_MAX_L2) continue;
        seen.add(cand); l2++;
        candidates.push({ word: cand, source: 'cilin', level: 'L2', strength: PARAMS.CILIN_STRENGTH_L2, via: [w] });
      }
    }
  }
  return resourceAwareResult(candidates, [['cilin', res]]);
}

// ---- 机制D: ATOMIC 事件推理(仅英文 chat/airp) ----
function atomicDiverge(enWords, enVerbs = []) {
  const res = loadAtomic();
  if (!res.available) return resourceAwareResult([], [['atomic', res]]);
  const { index } = res.data;
  const candidates = [];
  // 事件模板(设计: 提取动词+名词→"PersonX [verb] [noun]"): 动词与名词命中同一 head = 模板匹配,tail 优先入池
  const nounHeads = new Map(); // h → noun
  for (const n of enWords) for (const e of index.get(n.toLowerCase()) ?? []) if (!nounHeads.has(e.h)) nounHeads.set(e.h, n);
  for (const v of enVerbs) {
    for (const e of index.get(v.toLowerCase()) ?? []) {
      if (!nounHeads.has(e.h)) continue;
      // tail 取实义词入池: 剔 ATOMIC 模板占位词 PersonX/PersonY 与冠词介词(两处循环同一份内联表)
      for (const t of e.tail.toLowerCase().split(/\W+/)) {
        if (t.length < 3 || ['the', 'and', 'for', 'person', 'personx', 'persony'].includes(t)) continue;
        candidates.push({ word: t, source: 'atomic', relation: e.rel, strength: 0.6, via: [nounHeads.get(e.h), v], template: true });
      }
    }
  }
  for (const w of enWords) {
    const hits = index.get(w.toLowerCase());
    if (!hits) continue;
    for (const { rel, tail } of hits.slice(0, PARAMS.ATOMIC_TOPK)) {
      // tail 是短语("to feel better"),取实义词入池
      for (const t of tail.toLowerCase().split(/\W+/)) {
        if (t.length < 3 || ['the', 'and', 'for', 'person', 'personx', 'persony'].includes(t)) continue;
        candidates.push({ word: t, source: 'atomic', relation: rel, strength: PARAMS.ATOMIC_STRENGTH, via: [w] });
      }
    }
  }
  return resourceAwareResult(candidates, [['atomic', res]]);
}

// ---- code/work: 缩写展开 + 术语翻译 + 释义提名词(查表机制,产出也入池) ----
function termExpand(words, mode) {
  const abbr = loadAbbrCode(), seAbbr = loadSeAbbr(), comp = loadComputerese(),
    ai = loadAiTerms(), glosNouns = loadGlossaryNouns(), glos = loadGlossaries(),
    basic = loadBasicTech();
  const candidates = [];
  const translatedEn = [];
  const notes = [];
  const domainWords = mode === 'work' ? loadDomainWords() : { available: false };
  const requiredResources = [
    ['abbrCode', abbr], ['seAbbr', seAbbr], ['computerese', comp], ['aiTerms', ai],
    ['glossaryNouns', glosNouns], ['glossaries', glos], ['basicTech', basic],
  ];
  if (mode === 'work') requiredResources.push(['domainWords', domainWords]);
  for (const w of words) {
    const lw = w.toLowerCase();
    // 缩写 → 英文全称
    for (const tbl of [abbr, seAbbr]) {
      if (tbl.available && tbl.data.has(lw)) {
        const full = tbl.data.get(lw);
        candidates.push({ word: full, source: 'abbr_expand', strength: 0.8, via: [w] });
        translatedEn.push(...full.toLowerCase().split(/\W+/).filter(x => x.length > 2));
      }
    }
    // 基础中英技术词对照(覆盖"代码→code"等高频单词)
    if (basic.available && basic.data.has(w)) {
      const en = basic.data.get(w);
      candidates.push({ word: en, source: 'basic_tech', strength: 0.8, via: [w] });
      translatedEn.push(...en.toLowerCase().split(/\W+/).filter(x => x.length > 2));
    }
    // 中文术语 → 英文(work: AI 术语库;code: computerese 反查)
    if (ai.available && ai.data.has(w)) {
      const en = ai.data.get(w);
      candidates.push({ word: en, source: 'term_translate', strength: 0.7, via: [w] });
      translatedEn.push(...en.toLowerCase().split(/\W+/).filter(x => x.length > 2));
    }
    if (comp.available) {
      // computerese 表是 en→zh,反向查中文术语
      // 线性扫全表反查: 表仅千级行、每输入词最多扫一遍,不值得建反向索引;表若增大先测再改
      for (const [en, zh] of comp.data) {
        if (zh === w) {
          candidates.push({ word: en, source: 'term_translate', strength: 0.7, via: [w] });
          translatedEn.push(...en.split(/\W+/).filter(x => x.length > 2));
          break;
        }
      }
    }
    // DomainWordsDict 领域词确认(work 模式): 精确查询离线确定性 shard，不全量装 Set/扫描源目录
    if (domainWords.available && domainWords.data.has(w)) {
      candidates.push({ word: w, source: 'domain_confirm', strength: 0.3, via: [w] });
    }
    // 释义展开: 术语定义中的名词作为关联词(Stanza NOUN/PROPN 提取,预处理生成)
    if (glosNouns.available && glosNouns.data.has(lw)) {
      for (const noun of glosNouns.data.get(lw)) {
        candidates.push({ word: noun, source: 'definition_expand', strength: 0.5, via: [w] });
      }
    } else if (glos.available && glos.data.has(lw)) {
      for (const t of glos.data.get(lw).toLowerCase().split(/\W+/)) {
        if (t.length > 3) candidates.push({ word: t, source: 'definition_expand', strength: 0.5, via: [w] });
      }
    }
  }
  if (domainWords.available) {
    const stats = domainWords.data.cacheStats();
    notes.push(`domainWords shards=${stats.shards}/${stats.maxShards}; cachedEntries=${stats.cachedEntries}; hits=${stats.hits}; misses=${stats.misses}; evictions=${stats.evictions}; totalEntries=${stats.totalEntries}`);
  }
  return resourceAwareResult(candidates, requiredResources, {
    translatedEn: [...new Set(translatedEn)],
    note: notes.join('; ') || null,
  });
}

// ---- 机制F: CFN 中文语义框架发散(仅 work 模式中文) ----
// 设计§work: CFN=✓; 输入词查 CFN 框架元素 → 同框架的其他词入池(语义框架=同一场景的词群)
function cfnDiverge(words) {
  const res = loadCfnLex();
  if (!res.available) return resourceAwareResult([], [['cfnLex', res]]);
  const { wordToFrames, frameToWords } = res.data;
  const candidates = [];
  const seenFrames = new Set(); // 同一 frame 只展开一次(多个输入词命中同 frame 不重复)
  for (const w of words) {
    const frames = wordToFrames.get(w);
    if (!frames) continue;
    for (const frame of frames) {
      if (seenFrames.has(frame)) continue;
      seenFrames.add(frame);
      const siblings = frameToWords.get(frame);
      if (!siblings) continue;
      let taken = 0;
      for (const cand of siblings) {
        if (cand === w || taken >= PARAMS.CFN_MAX_PER_FRAME) continue;
        taken++;
        candidates.push({ word: cand, source: 'cfn', frame, strength: PARAMS.CFN_STRENGTH, via: [w] });
      }
    }
  }
  return resourceAwareResult(candidates, [['cfnLex', res]]);
}

// ---- 机制G: 域词表亲缘扩展(code/work 模式: THUOCL_IT + DomainWordsDict计算机业) ----
// 设计来源: 交接0801 §mode分流消歧 "code/work种子词查THUOCL_IT+DomainWordsDict计算机业取域内关联词"
// 原理: 输入词在域词表中 → 找包含该词的其他域术语(如 bug→debug/bugfix, 缺陷→软件缺陷)
function domainItExpand(words) {
  const thuocl = loadThuoclIt();
  const domIt = loadDomainWordsIt();
  const resources = [['thuoclIt', thuocl], ['domainWordsIt', domIt]];
  if (!thuocl.available && !domIt.available) return resourceAwareResult([], resources);
  const candidates = [];
  const itWords = thuocl.available ? thuocl.data : new Set();
  const csWords = domIt.available ? domIt.data : new Set();
  for (const w of words) {
    if (w.length < 2) continue;
    const inIt = itWords.has(w) || csWords.has(w);
    if (!inIt) continue;
    let taken = 0;
    for (const term of itWords) {
      if (taken >= 8) break;
      if (term !== w && term.length > w.length && term.includes(w)) {
        candidates.push({ word: term, source: 'domain_it', strength: 0.5, via: [w] });
        taken++;
      }
    }
    for (const term of csWords) {
      if (taken >= 12) break;
      if (term !== w && term.length > w.length && term.includes(w) && !itWords.has(term)) {
        candidates.push({ word: term, source: 'domain_it', strength: 0.4, via: [w] });
        taken++;
      }
    }
  }
  return resourceAwareResult(candidates, resources);
}

// ---- 汇池: CombSUM 加性合并 + 共振标记 ----
function pool(allCandidates, inputSet) {
  const poolMap = new Map();
  for (const c of allCandidates) {
    const key = c.word;
    if (inputSet.has(key)) continue; // 原词不算发散产出
    if (!poolMap.has(key)) {
      poolMap.set(key, { word: key, sources: [], strength: 0, via: new Set(), rels: [] });
    }
    const p = poolMap.get(key);
    if (!p.sources.includes(c.source)) p.sources.push(c.source);
    p.strength += c.strength;             // CombSUM(run27 加性 +62%)
    (c.via ?? []).forEach(v => p.via.add(v));
    if (c.rel || c.relation) p.rels.push(c.rel ?? c.relation);
    if (c.source === 'user_vocab' && c.matchType) {
      (p.userVocabMatches ??= []).push({
        type: c.matchType,
        from: c.via?.[0] ?? null,
        unit: c.matchUnit ?? null,
        tokens: c.matchedTokens ?? [],
        file: c.file ?? null,
      });
    }
  }
  // 池内 strength 归一(max=1): 各机制量纲不同,绝对值无意义,只保留池内相对强弱
  let maxS = 0;
  for (const p of poolMap.values()) maxS = Math.max(maxS, p.strength);
  for (const p of poolMap.values()) {
    p.via = [...p.via];
    p.resonance = p.sources.length;       // 跨机制共振数(≥2 = converging evidence 高置信)
    p.strength = maxS > 0 ? +(p.strength / maxS).toFixed(3) : 0;
  }
  return poolMap;
}

// 用户词库短语匹配只在本请求的 Node1 token 流内完成，不向共享 jieba 注词，避免跨用户污染。
// 规范化只去空白/标点/符号并做 Unicode+大小写归一；匹配仍要求由完整 token 边界连续组成，
// 因而不会用任意字符串 contains 把 token 内部子片段误判为命中。
const USER_VOCAB_SEPARATORS = /[\p{White_Space}\p{P}\p{S}]+/gu;
function normalizeUserVocabPhrase(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(USER_VOCAB_SEPARATORS, '');
}

function buildUnitWordSequences(contextTokens) {
  const units = new Map();
  for (const token of Array.isArray(contextTokens) ? contextTokens : []) {
    const normalized = normalizeUserVocabPhrase(token?.word);
    if (!normalized) continue;
    const unit = Number.isInteger(token?.unit) ? token.unit : 0;
    if (!units.has(unit)) units.set(unit, []);
    units.get(unit).push({ raw: String(token.word), normalized });
  }
  return units;
}

function findCompletePhraseMatch(normalizedFrom, unitSequences) {
  if ([...normalizedFrom].length < 2) return null;
  for (const [unit, tokens] of unitSequences) {
    for (let start = 0; start < tokens.length; start++) {
      let combined = '';
      for (let end = start; end < tokens.length; end++) {
        combined += tokens[end].normalized;
        if (!normalizedFrom.startsWith(combined)) break;
        if (combined === normalizedFrom && end > start) {
          return { unit, tokens: tokens.slice(start, end + 1).map(token => token.raw) };
        }
      }
    }
  }
  return null;
}

function userVocabDiverge(words, contextTokens, userVocab) {
  const rows = Array.isArray(userVocab?.entries) ? userVocab.entries : [];
  const exact = new Set(words.map(word => String(word)));
  const folded = new Set(words.map(word => String(word).toLowerCase()));
  const unitSequences = buildUnitWordSequences(contextTokens);
  const candidates = [];
  let exactTokenCount = 0;
  let phraseHotplugCount = 0;
  for (const row of rows) {
    const from = String(row?.from ?? '').trim();
    const to = String(row?.to ?? '').trim();
    if (!from || !to) continue;
    const exactToken = exact.has(from) || folded.has(from.toLowerCase());
    const phraseMatch = exactToken
      ? null
      : findCompletePhraseMatch(normalizeUserVocabPhrase(from), unitSequences);
    if (!exactToken && !phraseMatch) continue;
    const matchType = exactToken ? 'exact-token' : 'phrase-hotplug';
    if (exactToken) exactTokenCount++;
    else phraseHotplugCount++;
    candidates.push({
      word: to,
      source: 'user_vocab',
      strength: 0.8,
      via: [from],
      file: row.file ?? null,
      matchType,
      matchUnit: phraseMatch?.unit ?? null,
      matchedTokens: phraseMatch?.tokens ?? [from],
    });
  }
  return {
    candidates,
    note: `files=${Number(userVocab?.files) || 0}; entries=${rows.length}; exact-token=${exactTokenCount}; phrase-hotplug=${phraseHotplugCount}`,
  };
}

// ---- 发散后过滤(设计原文逐字:"经过swow的还需要再次删除动词,虚词和常见虚词类动词") ----
// 优先级链逐字承设计标注(_isNonInfoN2): 原词保护 > 程度副词豁免 > POS虚词 > BCC超高频(800000) > 停用词 > 口语补集
// 程度副词白名单与旧链同源(框架红线: 程度副词不排);口语补集兜"常见虚词类动词"(干嘛/没事/什么事…)
const DEGREE_WORDS = new Set([
  '死了', '太', '好', '很', '非常', '超', '特别', '真', '实在', '真的', '简直', '完全', '彻底', '这么', '那么',
  '挺', '蛮', '颇', '相当', '极', '极其', '分外', '格外', '更', '更加', '越发', '尤其',
  'so', 'really', 'extremely', 'absolutely', 'totally', 'completely',
]);
// 广义无信息词类(首字母归一): r代词/u助词/p介词/c连词/e叹词/y语气/o拟声/d副词 + t时间/m数/q量
// t/m/q 严格说非虚词,但对检索无区分度;时间信息另有 node1 timeAnchors 通道,不靠 t 词性词进池
const NOISE_POS_HEAD = new Set(['r', 'u', 'p', 'c', 'e', 'y', 'o', 'd', 't', 'm', 'q']);
let _colloq = null;
function colloqSet() {
  if (!_colloq) {
    try { _colloq = new Set(Object.keys(JSON.parse(readFileSync(findResource('p1_colloquial_noninfo.json'), 'utf8')))); }
    catch { _colloq = new Set(); }
  }
  return _colloq;
}

export function secondPassFilter(poolMap, {
  posLookup = new Map(), inputSet = new Set(), mode = 'chat', mechanismDiagnostics = null,
} = {}) {
  const stopSet = loadStopwordsCN();
  const meld = loadMeldSch();
  const removed = [];
  // moetype ACG 保护: ACG 专名词不被常规过滤干掉(角色名/作品名/ACG术语是有信息量的内容词)
  const moe = loadMoetypeAcg();
  const moetypeSet = moe.available ? moe.data : new Set();
  let moetypeProtected = 0;
  // 域消歧(code/work): THUOCL_animal 内但不在 THUOCL_IT 内的候选 = 错域(bug→insect 消歧)
  const isCodeWork = mode === 'code' || mode === 'work';
  let animalSet = null, itSet = null;
  let animalResource = null, itResource = null;
  let domainAnimalFiltered = 0;
  if (isCodeWork) {
    const an = loadThuoclAnimal();
    const it = loadThuoclIt();
    animalResource = an;
    itResource = it;
    animalSet = an.available ? an.data : null;
    itSet = it.available ? it.data : null;
  }
  for (const [word, p] of poolMap) {
    let reason = null;
    const isZh = /\p{Script=Han}/u.test(word);
    // 域消歧: code/work 模式下, 在动物域但不在 IT 域的候选词抑制
    if (isCodeWork && isZh && animalSet && itSet && animalSet.has(word) && !itSet.has(word) && !inputSet.has(word)) {
      reason = 'domain_animal';
      domainAnimalFiltered++;
    } else if (isZh) {
      if (word.length === 1) reason = 'frag';
      else if (inputSet.has(word) || DEGREE_WORDS.has(word)) reason = null;
      else if (moetypeSet.has(word)) {
        reason = null; // moetype ACG 词保护: 不进后续过滤
        moetypeProtected++;
      }
      else {
        const pos = posLookup.get(word);
        if (pos && (NOISE_POS_HEAD.has(pos[0]) || /^v/.test(pos))) reason = 'pos';
        else if (bccFreq(word) > N1_PARAMS.BCC_SUPERHIGH) reason = 'bcc';
        else if (stopSet.has(word)) reason = 'stop';
        else if (colloqSet().has(word)) reason = 'colloq';
        else {
          const conc = meld.get(word);
          if (conc !== undefined && conc < N1_PARAMS.CONC_FLOOR) reason = 'conc';
        }
      }
    } else {
      if (word.length < 3) reason = 'short_en';
    }
    if (reason) {
      removed.push({ word, reason, sources: p.sources });
      poolMap.delete(word);
    }
  }
  if (Array.isArray(mechanismDiagnostics)) {
    const moeErrors = moe.available ? [] : [optionalResourceDiagnostic('moetypeAcg', moe)];
    mechanismDiagnostics.push({
      mechanism: 'moetype_filter',
      kind: 'filter',
      produced: moetypeProtected,
      status: moe.available ? 'available' : 'unavailable',
      note: moeErrors.map(error => error.message).join('; ') || null,
      errors: moeErrors,
    });
    if (isCodeWork) {
      const resources = [['thuoclAnimal', animalResource], ['thuoclIt', itResource]];
      const domainErrors = resources
        .filter(([, result]) => !result?.available)
        .map(([resource, result]) => optionalResourceDiagnostic(resource, result));
      mechanismDiagnostics.push({
        mechanism: 'thuocl_domain_filter',
        kind: 'filter',
        produced: domainAnimalFiltered,
        status: domainErrors.length
          ? (resources.some(([, result]) => result?.available) ? 'degraded' : 'unavailable')
          : 'available',
        note: domainErrors.map(error => error.message).join('; ') || null,
        errors: domainErrors,
      });
    }
  }
  return removed;
}

// ---- 主入口 ----
// mode: chat | airp | code | work ;  node1Result: tokenizeUnits 输出
export async function diverge(node1Result, mode = 'chat', opts = {}) {
  const kept = node1Result.contextTokens.filter(t => !t.filtered);
  // 锚词集(pipeline 按凛倾锁定值收口传入);未传=全量保留词(独立调用兼容)
  const anchorSet = opts.anchorWords ? new Set(opts.anchorWords) : null;
  const anchored = anchorSet ? kept.filter(t => anchorSet.has(t.word)) : kept;
  const zhWords = [...new Set(anchored.filter(t => t.lang === 'zh').map(t => t.word))];
  const enWordsRaw = [...new Set(anchored.filter(t => t.lang === 'en').map(t => t.word.toLowerCase()))];
  const inputSet = new Set([...zhWords, ...enWordsRaw]);

  const runs = []; // 白盒: 每个机制的产出、状态与错误
  const errors = [];
  const all = [];
  // 可插拔(凛倾0801框架): 每个发散机制=独立词库+独立函数,可按配置关停;
  // 关停的机制在白盒里如实显示 disabled,不静默消失
  const disabled = new Set(opts.mechanisms?.disable
    ?? (process.env.P1_MECH_DISABLE ?? '').split(',').map(s => s.trim()).filter(Boolean));
  const recordMechanism = record => {
    const mechanismErrors = (record.errors ?? []).map(error => ({
      ...error,
      mechanism: error.mechanism ?? record.mechanism,
    }));
    const normalized = {
      kind: record.kind ?? 'expansion',
      mechanism: record.mechanism,
      produced: Number(record.produced) || 0,
      status: record.status ?? (mechanismErrors.length ? 'degraded' : 'available'),
      note: record.note ?? (mechanismErrors.map(error => error.message).join('; ') || null),
      errors: mechanismErrors,
    };
    runs.push(normalized);
    errors.push(...mechanismErrors);
    return normalized;
  };
  const runMech = (name, fn) => {
    const baseName = name.replace(/\(.*\)$/, ''); // term_expand(code) 类带模式后缀的机制名,禁用配置按基名匹配
    if (disabled.has(baseName)) {
      recordMechanism({ mechanism: name, produced: 0, status: 'disabled', note: 'disabled(插拔关闭)' });
      return { candidates: [], translatedEn: [], status: 'disabled', errors: [] };
    }
    let r;
    try {
      r = fn();
    } catch (error) {
      const diagnostic = mechanismDiagnostic(error, name);
      recordMechanism({
        mechanism: name,
        produced: 0,
        status: 'error',
        note: diagnostic.message,
        errors: [diagnostic],
      });
      return { candidates: [], translatedEn: [], status: 'error', errors: [diagnostic] };
    }
    const candidates = Array.isArray(r?.candidates) ? r.candidates : [];
    recordMechanism({
      mechanism: name,
      produced: candidates.length,
      status: r?.status ?? 'available',
      note: r?.note ?? (r?.notes?.join('; ') || null),
      errors: r?.errors ?? [],
    });
    all.push(...candidates);
    return { ...r, candidates, translatedEn: r?.translatedEn ?? [], errors: r?.errors ?? [] };
  };

  let enWords = enWordsRaw;
  if (mode === 'code' || mode === 'work') {
    // code/work: 先缩写展开+术语翻译,翻译产物回流英文发散(设计 §code SWOW 接入路径)
    const t = runMech(`term_expand(${mode})`, () => termExpand([...zhWords, ...enWordsRaw], mode));
    enWords = [...new Set([...enWordsRaw, ...t.translatedEn])];
    runMech('swow_zh', () => swowDiverge(zhWords, 'zh'));
    runMech('swow_en', () => swowDiverge(enWords, 'en'));
    runMech('conceptnet_zh', () => conceptnetDiverge(zhWords, 'zh'));
    runMech('conceptnet_en', () => conceptnetDiverge(enWords, 'en'));
    // work 专属: CFN 中文语义框架发散(设计§work: CFN=✓)
    if (mode === 'work' && zhWords.length) {
      runMech('cfn', () => cfnDiverge(zhWords));
    }
    // code/work: 域词表亲缘扩展(THUOCL_IT + DomainWordsDict计算机业)
    runMech('domain_it', () => domainItExpand([...zhWords, ...enWordsRaw]));
  } else {
    // chat/airp 中文: SWOW-ZH + ConceptNet + 词林;英文: SWOW-EN + ATOMIC + ConceptNet
    runMech('swow_zh', () => swowDiverge(zhWords, 'zh'));
    runMech('conceptnet_zh', () => conceptnetDiverge(zhWords, 'zh'));
    runMech('cilin', () => cilinDiverge(zhWords));
    if (enWords.length) {
      runMech('swow_en', () => swowDiverge(enWords, 'en'));
      const enVerbs = [...new Set(node1Result.contextTokens.filter(t => t.lang === 'en' && t.upos === 'VERB').map(t => t.word.toLowerCase()))];
      runMech('atomic', () => atomicDiverge(enWords, enVerbs));
      runMech('conceptnet_en', () => conceptnetDiverge(enWords, 'en'));
    }
  }

  // 用户编辑的词库必须是真实发散机制，不是只写不读的 CRUD 孤链。
  runMech('user_vocab', () => userVocabDiverge(
    [...zhWords, ...enWords],
    node1Result.contextTokens,
    opts.userVocab,
  ));

  const poolMap = pool(all, inputSet);

  // 英文域消歧(code/work): WordNet supersense 过滤动物域词(bug→insect 消歧)
  // 仅 code/work 模式执行; chat/airp 保留所有联想(可能用户真的在聊动物)
  let wnDomainFiltered = [];
  if ((mode === 'code' || mode === 'work')) {
    const enPoolWords = [...poolMap.keys()].filter(w => /^[a-zA-Z]/.test(w) && w.length >= 3);
    if (enPoolWords.length) {
      try {
        const r = await httpCall('vector', 'wn_supersense', { words: enPoolWords });
        if (r?.available === true && r.results && typeof r.results === 'object' && !Array.isArray(r.results)) {
          const ANIMAL_DOMAINS = new Set(['noun.animal', 'noun.plant']);
          const IT_DOMAINS = new Set(['noun.artifact', 'noun.communication', 'noun.cognition', 'noun.act', 'noun.attribute']);
          for (const w of enPoolWords) {
            const domains = r.results[w];
            if (!domains || !domains.length) continue;
            const allAnimal = domains.every(d => ANIMAL_DOMAINS.has(d));
            const anyIt = domains.some(d => IT_DOMAINS.has(d));
            if (allAnimal && !anyIt && !inputSet.has(w.toLowerCase())) {
              wnDomainFiltered.push({ word: w, domains, sources: poolMap.get(w)?.sources ?? [] });
              poolMap.delete(w);
            }
          }
          recordMechanism({
            mechanism: 'wn_supersense_filter',
            kind: 'filter',
            produced: wnDomainFiltered.length,
            status: 'available',
            note: `queried=${enPoolWords.length}; filtered=${wnDomainFiltered.length}`,
          });
        } else {
          const cause = r?.error ?? r?.why ?? 'response missing available=true results object';
          const diagnostic = mechanismDiagnostic({
            code: r?._cluster_err
              ? 'E_P1_WN_SUPERSENSE_QUERY_FAILED'
              : 'E_P1_WN_SUPERSENSE_UNAVAILABLE',
            message: cause,
            details: {
              available: r?.available ?? null,
              clusterError: r?._cluster_err === true,
              status: r?.status ?? null,
            },
          }, 'wn_supersense_filter');
          recordMechanism({
            mechanism: 'wn_supersense_filter',
            kind: 'filter',
            produced: 0,
            status: 'unavailable',
            note: diagnostic.message,
            errors: [diagnostic],
          });
        }
      } catch (error) {
        const diagnostic = mechanismDiagnostic(error, 'wn_supersense_filter', 'E_P1_WN_SUPERSENSE_QUERY_FAILED');
        recordMechanism({
          mechanism: 'wn_supersense_filter',
          kind: 'filter',
          produced: 0,
          status: 'error',
          note: diagnostic.message,
          errors: [diagnostic],
        });
      }
    } else {
      recordMechanism({
        mechanism: 'wn_supersense_filter',
        kind: 'filter',
        produced: 0,
        status: 'skipped',
        note: 'no eligible English pool words',
      });
    }
  }

  // 设计§发散后过滤"再次删除动词": 池内中文词批量过 jieba 桥拿真词性(审查0801抓出未传posLookup=该层空转)
  const zhPoolWords = [...poolMap.keys()].filter(w => /\p{Script=Han}/u.test(w));
  const posLookup = new Map();
  if (zhPoolWords.length) {
    const br = await bridgeTokenize(zhPoolWords);
    zhPoolWords.forEach((w, i) => {
      const toks = br.results[i];
      if (toks?.length === 1) posLookup.set(w, toks[0].pos); // 整词命中才可信,切碎的不判
    });
  }
  const filterDiagnostics = [];
  const removed = secondPassFilter(poolMap, {
    posLookup, inputSet, mode, mechanismDiagnostics: filterDiagnostics,
  });
  for (const diagnostic of filterDiagnostics) recordMechanism(diagnostic);

  return {
    mode,
    inputWords: { zh: zhWords, en: enWords },
    pool: [...poolMap.values()].sort((a, b) => b.resonance - a.resonance || b.strength - a.strength),
    removedBySecondPass: removed,
    wnDomainFiltered,
    mechanisms: runs,
    status: errors.length ? 'degraded' : 'ok',
    errors,
    params: { ...PARAMS },
  };
}
