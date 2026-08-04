// selfDrivenP1_utils.mjs — 40+全局缓存单例 + 64个工具函数 (2026-05-31 核对: 42行 `let _X=null` 声明, 含双声明行/标量)
// ╔═══ 改动须知 ════════════════════════════════════════════════╗
// ║ 调用方: selfDrivenP1/selfDrivenP1_diverge + p1_diverge/    ║
// ║         p1_position/p1_legacy/p1_phaseT/p1_t45 (均 import)  ║
// ║ _getActivationTerms: 返回{dim:{term:meta}}格式,7处消费     ║
// ║ _getBccDict: 返回Map<string,number>,10+处消费              ║
// ║ 不能改: 返回值类型/key格式/export名                         ║
// ╚═════════════════════════════════════════════════════════════╝

// utils 只需要以下外部依赖:
import { getNumberbatch } from "../nlp/numberbatch.mjs";
import { getMemoryDir, diag } from "../storage_mod/storage.mjs";
import { getEscalationLex } from "../nlp/escalationLex.mjs";
import { getAxisLex } from "../nlp/axisLex.mjs";
import { textEmotion, detectLang } from "../nlp/enEmotion.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findResource as _resdirFind } from "../p1/p1_resdir.mjs"; // P0-2 统一资源定位(此处原是第11处漏网: 分段拼接"前端计划","P1资源库"死路径, grep 整串模式扫不到)

function resolveResource(filename) {
  const candidates = [
    path.join(__sdp_dirname, filename),
    path.join(__sdp_dirname, "resources", filename),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return _resdirFind(filename); // 本次启动的唯一 P1_RESOURCE_DIR
}

// v37: vocab.mjs重构后不再导出_getBccDict等，内联stub
let _bccDictCache = null, _bccFreqCache = null;
/** @contract 返回: Map<string,number> — 词→BCC频率
 *  @consumers _getBccFreq(本文件), runStep1Extract(贪心分词), p1_diverge(BCC前置过滤)
 *  @breaking 改Map类型→分词+SWOW+全链路崩 */
function _getBccDict() {
  if (_bccDictCache) return _bccDictCache;
  try {
    const f = resolveResource("multi_domain_total_word_freq.txt");
    if (!f) { _bccDictCache = new Map(); return _bccDictCache; }
    _bccDictCache = new Map();
    const lines = fs.readFileSync(f, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || i === 0 && line.startsWith("token")) continue;
      const sep = line.includes("\t") ? "\t" : ",";
      const idx = line.lastIndexOf(sep);
      if (idx < 0) continue;
      const w = line.substring(0, idx).trim();
      const freq = parseInt(line.substring(idx + 1));
      if (w && !isNaN(freq)) _bccDictCache.set(w, freq);
    }
  } catch { _bccDictCache = new Map(); }
  return _bccDictCache;
}
function _getBccFreq(w) { return _getBccDict().get(w) || 0; }
// P9 fix 20260509: _isPosNoise 已被 vocab.mjs 的 _isPosNoiseWC 替代, 0 调用, 删除死代码
// 172#1+#2 修复: 英文词豁免 bccDict (bccDict 是中文词典,用它过滤会砍掉所有英文词)
function _isEnWord(w) { return typeof w === "string" && /^[a-zA-Z][a-zA-Z\-_]*$/.test(w); }

// 172#64 修复: 极性词库 hot-reload (替代 22 处硬编码 Set + 正则匹配)
// 凛倾原话: "正则匹配,包括筛选,这些都是致命的.我们之前有设计过,3个大类"
// 设计来源: 75 号 MD 大/中/小三级 + 98 号 MD heavy/light/pos_input 三强度
let _polarityLexCache = null;
// MD 出处: 本轮 #64 (22 处硬编码 Set → polarity_lexicon.json,427 词外化)
//          152号 §五 热插拔(实现为 mtime 30s polling, 见 _checkHotReload; 非 fs.watch)
//          150号 §A 词库化
// 概念: heavy_neg/pos_input/pos_chat_zh/pos_chat_en/negation_zh/negation_en/adversative_en/embodied/airp_creative_verbs/recall_noise/term_noise/en_stop/term_filter/mode_fallback
//       14 个子分组,427 词(以 polarity_lexicon.json 实际计,排除 _meta),从硬编码 Set 外化为 JSON
// 实现: 读 polarity_lexicon.json,_polSet(group, name) 拿对应 Set,_checkHotReload 30s 轮询
function _getPolarityLex() {
  if (_polarityLexCache) return _polarityLexCache;
  try {
    const p = path.join(__sdp_dirname, "polarity_lexicon.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === "_meta") continue;
      if (Array.isArray(v)) out[k] = new Set(v);
      else if (typeof v === "object") {
        out[k] = {};
        for (const [sk, sv] of Object.entries(v)) {
          if (Array.isArray(sv)) out[k][sk] = new Set(sv);
        }
      }
    }
    _polarityLexCache = out;
    return out;
  } catch {
    _polarityLexCache = {};
    return {};
  }
}
function _polSet(group, name) {
  const lex = _getPolarityLex();
  if (name === undefined) return lex[group] instanceof Set ? lex[group] : new Set();
  return lex[group]?.[name] instanceof Set ? lex[group][name] : new Set();
}

// MD 出处: 187号 §一二 + 本轮 #66 + #67 (★主观→客观 alias 537→811)
// 概念: 凛倾"给方向不给路线"+"不是名词"原则的输出层落地
//       不改 lib 内部 key (term_alias 写在 buildContent / Phase T 输出层),
//       例: 离弃恐惧→遗弃焦虑(Bartholomew)/智性优越感→达克效应/哀伤五阶段→Kübler-Ross
// 应用点: cognitive_activation / p1_act / tech_signals / expansion.maps_to (本轮全覆盖)
// 凛倾原话: "我们给主AI的是方向,不是线路"
// 187# 方案 D: 主观→客观 alias 输出层替换 (537 条)
// 凛倾原话: "我们给主 AI 的是方向, 不是线路. 以线路分析为主, 禁止有诱导情况"
// 不改 lib 内部 key, 在 buildContent 输出 _rankedTerms 时把 old → new
let _termAliasCache = null;
function _getTermAlias() {
  if (_termAliasCache) return _termAliasCache;
  try {
    const p = path.join(__sdp_dirname, "term_alias.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    _termAliasCache = raw.alias || {};
    return _termAliasCache;
  } catch {
    _termAliasCache = {};
    return _termAliasCache;
  }
}
function _aliasMap(term) {
  const alias = _getTermAlias();
  return alias[term] || term;
}

// MD 出处: 130号 §valence_lex 接入 lab + 131号 vlex 规范对比合并验证
//          115号 (zh_valence 词库化扩充原始设计)
// 概念: 482 词带 {valence, arousal, source} 浮点精标,替代原 ZH_NEG/ZH_POS 二值
//       valence ∈ [-1,1] 连续值,|v|≥0.3 触发, arousal 接 ALL_DIMS.indexOf("arousal")
// 实现: Phase A 词处理 vlex 优先(× 0.6 权重) → fallback ZH_NEG/POS
// 验证: 130号 lab +0.139, 已合并主版本(本轮)待回归 eval 验证
// 130# valence_lex 接入 (lab 验证 +0.139)
// 482 词带 {valence, arousal, source} float 精标, 替代 ZH_NEG/ZH_POS 二值布尔
const _VLEX_ENABLED = true;
let _valenceLexCache = null;
function _getValenceLex() {
  if (_valenceLexCache !== null) return _valenceLexCache;
  const raw = _transferVocab?.chat?._valence_lex_zh;
  if (!raw) { _valenceLexCache = new Map(); return _valenceLexCache; }
  _valenceLexCache = new Map();
  for (const [word, entry] of Object.entries(raw)) {
    if (!word.startsWith("_")) _valenceLexCache.set(word, entry);
  }
  return _valenceLexCache;
}
let _jiebaCut = null;
try { const _jm = await import("jieba-wasm"); _jiebaCut = _jm.cut; } catch { _jiebaCut = null; }
function runStep1Extract(text) {
  if (!text) return { words: [], text: "" };
  const seen = new Set();
  const words = [];
  if (_jiebaCut) {
    const tokens = _jiebaCut(text, true);
    for (const w of tokens) {
      if (w.length < 2) continue;
      if (seen.has(w)) continue;
      if (/^[a-zA-Z]/.test(w)) { words.push(w); seen.add(w); continue; }
      if (/^[\u4e00-\u9fff]/.test(w)) {
        const freq = _getBccFreq(w);
        if (freq > 500000) continue;
        words.push(w); seen.add(w);
      }
    }
  } else {
    const zhSegs = text.match(/[\u4e00-\u9fff]+/g) || [];
    const en = text.match(/[a-zA-Z]{2,}/g) || [];
    for (const seg of zhSegs) {
      let pos = 0;
      while (pos < seg.length) {
        let best = null, bestLen = 1, bestFreq = 0;
        for (let len = Math.min(4, seg.length - pos); len >= 2; len--) {
          const w = seg.substring(pos, pos + len);
          const f = _getBccFreq(w);
          if (f > 0 && (len > bestLen || (len === bestLen && f > bestFreq))) { best = w; bestLen = len; bestFreq = f; }
        }
        if (best && bestFreq > 0) { if (!seen.has(best)) { words.push(best); seen.add(best); } pos += bestLen; }
        else { pos++; }
      }
    }
    for (const w of en) { if (!seen.has(w)) { words.push(w); seen.add(w); } }
  }
  return { words, text };
}
// (以上冗余 imports 已在文件顶部声明, 这里是原主文件对应位置的占位注释)

// cooccur seed: lccc 30K 对话生成的 18K word-pair(凛倾§16.34, sdConfig.cooccur 为空时 fallback)
// 倒排索引(P99 优化): word → [(other, count)] 排序好的, 避免每次 query 全扫 Map
const __sdp_dirname = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // lib/test/ → lib/ (JSON 数据文件在 lib/ 根)
let _cooccurSeed = null;
let _axisLexNbCache = null;
let _cooccurInvIdx = null;
let _transferVocab = null;
let _hubStats = null;
let _posVectors = null;
let _idiomLexicon = null;
let _cnValence = null;
let _frameworkPatterns = null;
let _emotionDirections = null;
let _frameworkCentroids = null;
let _tvSubCatValenceCache = null;
let _embodiedCentroidCache = null;
let _wcValenceMap = null;
let _sentimentZh = null;
let _sentimentEn = null;
let _cnCauseIdx = null;
let _strategyFnCache = null;
// EN_DIM模块级缓存: 首次runSelfDrivenP1后缓存,使主控早期cogDir(grep _enDimCache 消费处)也能查英文
let _enDimCache = null;
// cogmech反向映射: dimension→词数组(7902词, cogmech_reverse.json)
let _cogmechReverse = null;
// embodied大词库: 身体感受词Set(embodied_words.json)
let _embodiedWordsCache = null;
// SWOW-ZH全局缓存(专家2+4+5共识: 每轮重读2.7MB JSON浪费25-40ms)
let _swowZhCache = null;
// OVERUSED_PENALTY外化JSON(专家5建议): 万金油术语→惩罚系数, 热插拔可编辑
let _overusedPenaltyCache = null;
// 4层分类lookup: {术语名→{axis,dim,subCat}} 从4layer JSON反转构建
let _4layerLookupCache = null;
function _get4layerLookup() {
  if (_4layerLookupCache) return _4layerLookupCache;
  _4layerLookupCache = new Map();
  const files = [
    "activation_terms_4layer.json",
    "airp_classification_4layer.json",
    "activation_terms_code_taxonomy.json",
    "activation_terms_work_taxonomy.json",
  ];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, f), "utf-8"));
      for (const [axisName, dims] of Object.entries(raw)) {
        const axis = axisName.replace("轴", "");
        for (const [dim, subCats] of Object.entries(dims)) {
          for (const [subCat, terms] of Object.entries(subCats)) {
            if (!Array.isArray(terms)) continue;
            for (const term of terms) {
              if (typeof term === "string" && term.length >= 2) {
                _4layerLookupCache.set(term, { axis, dim, subCat });
              }
            }
          }
        }
      }
    } catch {}
  }
  return _4layerLookupCache;
}
// term_meta.json(Opus回顾A1): 730词register(technical/academic/colloquial/literary/neutral)
let _termMetaCache = null;
function _getTermMeta() {
  if (!_termMetaCache) {
    try { _termMetaCache = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "term_meta.json"), "utf-8")); }
    catch { _termMetaCache = {}; }
  }
  return _termMetaCache;
}
// mode_direction_vectors.json(Opus回顾A2): 4mode×18维统计权重
// P0-C fix 20260515: 14维→18维兼容. JSON若仅14维, 后4维(psychology/sociology/pragmatics/relationship)补0
// lab#4教训: 不盲目填大值, 0是最安全默认(=不boost也不penalize)
// /* 多档实验 */: 后4维系数待实测调优, 当前默认0
let _modeDirVecCache = null;
const _MDV_EXPECTED_DIMS = 18;
function _getModeDirVec(mode) {
  if (!_modeDirVecCache) {
    try { _modeDirVecCache = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "mode_direction_vectors.json"), "utf-8")); }
    catch { _modeDirVecCache = {}; }
    // 14维→18维兼容: 补0到18维 (仅对数组类型的mode向量)
    for (const k of Object.keys(_modeDirVecCache)) {
      const v = _modeDirVecCache[k];
      if (Array.isArray(v) && v.length < _MDV_EXPECTED_DIMS) {
        while (v.length < _MDV_EXPECTED_DIMS) v.push(0); /* 多档实验: 后4维默认0 */
      }
    }
  }
  return _modeDirVecCache[mode] || null;
}
// Phase T 激活术语库(146号MD): cogDir维度→专业激活术语(4场景×多维度)
// 凛倾: "运用一些简短的专业名词让提示词达到最大效果,你只需要用提示词去激活这个模块就行了"
let _activationTerms = null;
// 信号词库(凛倾: "正则太僵硬,需要一个库"): 4个JSON合并为4个Set, 替代hardcode正则做mode路由
let _signalLexicons = null;
// 热插拔(P9 P0, 152号MD): 词库JSON文件mtime变化→清缓存,beilu运行时不重启即时生效
// 凛倾: "热插拔词库. AI写入词库,然后标注"
const _hotReloadFiles = ["activation_terms.json","activation_terms_en.json","activation_terms_chat.json","activation_terms_work.json","signal_lexicons.json","chat_signal_lexicon.json","en_chat_signal_lexicon.json","ja_ko_chat_signal_lexicon.json","work_signal_lexicon.json","wordCoords.json","airp_work_technique_map.json","transfer_index_chat.json","transfer_index_code.json","transfer_index_airp.json","transfer_index_work.json","cogmech_reverse.json","sentiment_zh.json","sentiment_en.json","embodied_words.json","overused_penalty.json","meme_concepts.json","ide_diagnostic_paths.json","term_meta.json","mode_direction_vectors.json","character_psychology.json","polarity_lexicon.json","term_alias.json","activation_terms_4layer.json","airp_classification_4layer.json","activation_terms_code_taxonomy.json","activation_terms_work_taxonomy.json"]; // +4layer JSON热重载
const _hotReloadMtime = new Map();
let _lastHotReloadCheck = 0;
const _HOT_RELOAD_INTERVAL = 30000; // 30秒polling窗口
function _checkHotReload() {
  const now = Date.now();
  if (now - _lastHotReloadCheck < _HOT_RELOAD_INTERVAL) return;
  _lastHotReloadCheck = now;
  let dirty = false;
  for (const name of _hotReloadFiles) {
    try {
      const p = path.join(__sdp_dirname, name);
      if (!fs.existsSync(p)) continue;
      const mt = fs.statSync(p).mtimeMs;
      if (_hotReloadMtime.get(name) !== mt) {
        _hotReloadMtime.set(name, mt);
        dirty = true;
      }
    } catch {}
  }
  if (dirty) {
    // 清空所有词库缓存,下次getter自动重载
    _activationTerms = null;
    _signalLexicons = null;
    _memeIndex = null;
    _transferIndex = null;
    _airpTechniqueMap = null;
    _hubStats = null;
    _idiomLexicon = null;
    _cnValence = null;
    _wcValenceMap = null;
    _cogmechReverse = null;
    _embodiedWordsCache = null;
    _swowZhCache = null;
    _overusedPenaltyCache = null;
    _polarityLexCache = null;
    _termAliasCache = null;
    // A2 fix 20260507: 补清漏掉的13个缓存(深审P1 + 凛倾校准1: 热插拔必须完整)
    _termMetaCache = null;         // term_meta.json (在hotReload列表)
    _modeDirVecCache = null;       // mode_direction_vectors.json (在hotReload列表)
    _valenceLexCache = null;       // 依赖_transferVocab/_transferIndex (transfer_index_*.json在hotReload列表)
    _sentimentZh = null;           // sentiment_zh.json (在hotReload列表)
    _sentimentEn = null;           // sentiment_en.json (在hotReload列表)
    _cnCauseIdx = null;            // 深审P1指定漏清
    _strategyFnCache = null;       // 深审P1指定漏清
    _posVectors = null;            // 深审P1指定漏清
    _emotionDirections = null;     // 深审P1指定漏清
    _frameworkPatterns = null;     // 深审P1指定漏清
    _frameworkCentroids = null;    // 深审P1指定漏清 (依赖_frameworkPatterns)
    _tvSubCatValenceCache = null;  // 依赖_transferVocab (间接依赖hotReload)
    _embodiedCentroidCache = null; // 172号Bug#15永久缓存,脏时应清
    _4layerLookupCache = null;     // 4layer分类热重载
    _actTermFreqByUser.clear();    // P1 fix 20260509: 热重载时清空PE频次,防跨会话累积偏移
    _cooccurSeed = null;
    _axisLexNbCache = null;
    _cooccurInvIdx = null;
    _transferVocab = null;
    _cognitiveBiasCache = null;
    _sensorimotorZhCache = null;
    _xanewVadCache = null;
  }
}
// Phase T 动态PE计数器: 术语被选中越频繁→PE越低(万金油降权,灵光一现保持高PE)
// Predictive Coding (Karl Friston): 高PE=意外但相关=真正有价值的激活
// P0-3 fix 20260506: 改为双层 Map<userId, Map<term, count>> 防止跨用户污染
const _actTermFreqByUser = new Map();
const _MAX_ACT_TERM_FREQ_USERS = 50; // 最多保留50个用户，超出FIFO删最旧插入的条目
function _getActTermFreq(userId) {
  const _uid = userId || "_global";
  if (!_actTermFreqByUser.has(_uid)) {
    // FIFO: 超出上限时删最早插入的条目(Map迭代顺序=插入顺序,注释原写LRU有误)
    if (_actTermFreqByUser.size >= _MAX_ACT_TERM_FREQ_USERS) {
      const _firstKey = _actTermFreqByUser.keys().next().value;
      _actTermFreqByUser.delete(_firstKey);
    }
    _actTermFreqByUser.set(_uid, new Map());
  }
  return _actTermFreqByUser.get(_uid);
}
// 梗库concepts索引: 梗文本→对应的cogDir维度标签(用于Phase T额外路由信号)
let _memeIndex = null;
// 72号MD: per-mode倒排索引(concepts+SWOW+CiLin预构建)
let _transferIndex = null;

function _getMemeIndex() {
  if (_memeIndex) return _memeIndex;
  _memeIndex = new Map();
  try {
    const actTerms = _getActivationTerms();
    for (const [mode, dims] of Object.entries(actTerms)) {
      for (const [dim, terms] of Object.entries(dims)) {
        for (const [term, meta] of Object.entries(terms)) {
          if (!meta.concepts) continue;
          for (const c of meta.concepts) {
            const key = c.toLowerCase();
            if (!_memeIndex.has(key)) _memeIndex.set(key, []);
            _memeIndex.get(key).push({ dim, term, mode });
          }
        }
      }
    }
  } catch {}
  // 追加meme_concepts.json: 网络梗→activation_terms术语的直接映射
  // 229个梗词(破防/emo/摆烂/芜湖等)→maps_to中的心理学术语
  try {
    const _mc = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "meme_concepts.json"), "utf-8"));
    const _termDimMap = new Map();
    const actTerms = _getActivationTerms();
    for (const [mode, dims] of Object.entries(actTerms)) {
      for (const [dim, terms] of Object.entries(dims)) {
        for (const term of Object.keys(terms)) _termDimMap.set(term, { dim, mode });
      }
    }
    for (const cat of Object.values(_mc)) {
      if (!cat.memes) continue;
      for (const m of cat.memes) {
        const key = m.meme.toLowerCase();
        if (!m.maps_to) continue;
        for (const targetTerm of m.maps_to) {
          const info = _termDimMap.get(targetTerm);
          if (!info) continue;
          if (!_memeIndex.has(key)) _memeIndex.set(key, []);
          _memeIndex.get(key).push({ dim: info.dim, term: targetTerm, mode: info.mode });
        }
      }
    }
  } catch {}
  // 追加ide_diagnostic_paths.json: 编程问题关键词→code术语映射
  // 30个编程问题的common_causes作为触发词→activation_terms术语
  try {
    const _ide = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "ide_diagnostic_paths.json"), "utf-8"));
    const actTerms = _getActivationTerms();
    const codeDims = actTerms.code || {};
    for (const [problem, data] of Object.entries(_ide)) {
      if (!data.common_causes) continue;
      // 问题名本身作为触发词
      const triggers = [problem, ...(data.common_causes || [])];
      // 找到对应的activation_terms
      const targetTerms = data.activation_terms || [];
      for (const trigger of triggers) {
        const key = trigger.toLowerCase();
        for (const targetTerm of targetTerms) {
          // 查找术语在哪个dim
          for (const [dim, terms] of Object.entries(codeDims)) {
            if (terms[targetTerm]) {
              if (!_memeIndex.has(key)) _memeIndex.set(key, []);
              _memeIndex.get(key).push({ dim, term: targetTerm, mode: "code" });
            }
          }
        }
      }
    }
  } catch {}
  // 追加character_psychology.json: 角色名→心理学maps_to术语(Plutchik/ABC/依恋/防御机制)
  // 74个角色(动漫36/游戏22/西方10/小说4): 用户提到角色名→激活心理学术语
  try {
    const _cp = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "character_psychology.json"), "utf-8"));
    const _termDimMap2 = new Map();
    const actTerms = _getActivationTerms();
    for (const [mode, dims] of Object.entries(actTerms)) {
      for (const [dim, terms] of Object.entries(dims)) {
        for (const term of Object.keys(terms)) _termDimMap2.set(term, { dim, mode });
      }
    }
    for (const [charName, data] of Object.entries(_cp.characters || {})) {
      const triggers = [charName, ...(data.aliases || [])];
      for (const trigger of triggers) {
        const key = trigger.toLowerCase();
        for (const targetTerm of (data.maps_to || [])) {
          const info = _termDimMap2.get(targetTerm);
          if (!info) continue;
          if (!_memeIndex.has(key)) _memeIndex.set(key, []);
          _memeIndex.get(key).push({ dim: info.dim, term: targetTerm, mode: info.mode });
        }
      }
    }
  } catch {}
  return _memeIndex;
}

function _getTransferIndex(mode) {
  if (!_transferIndex) _transferIndex = {};
  if (_transferIndex[mode]) return _transferIndex[mode];
  try {
    const f = path.join(__sdp_dirname, `transfer_index_${mode}.json`);
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, "utf-8"));
      _transferIndex[mode] = new Map(Object.entries(raw));
    } else {
      _transferIndex[mode] = new Map();
    }
  } catch { _transferIndex[mode] = new Map(); }
  return _transferIndex[mode];
}

// cogmech反向映射懒加载: dimension→词数组(7902词), fallback空对象
function _getCogmechReverse() {
  if (_cogmechReverse) return _cogmechReverse;
  try {
    _cogmechReverse = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "cogmech_reverse.json"), "utf-8"));
  } catch { _cogmechReverse = {}; }
  return _cogmechReverse;
}

// embodied大词库懒加载: 身体感受词Set, fallback原硬编码30词
function _getEmbodiedWords() {
  if (_embodiedWordsCache) return _embodiedWordsCache;
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "embodied_words.json"), "utf-8"));
    _embodiedWordsCache = new Set(arr);
  } catch {
    // fallback到原硬编码
    _embodiedWordsCache = _polSet("embodied");
  }
  return _embodiedWordsCache;
}

function _getWcValenceMap() {
  if (_wcValenceMap) return _wcValenceMap;
  _wcValenceMap = new Map();
  try {
    const f = path.join(__sdp_dirname, "wordCoords.json");
    const data = JSON.parse(fs.readFileSync(f, "utf-8"));
    for (const [term, entry] of Object.entries(data)) {
      if (entry?.coords) {
        _wcValenceMap.set(term, {
          vp: entry.coords.valence_pos || 0,
          vn: entry.coords.valence_neg || 0,
        });
      } else if (typeof entry?.valence === "number") {
        const v = entry.valence;
        _wcValenceMap.set(term, { vp: Math.max(0, v), vn: Math.max(0, -v) });
      }
    }
  } catch {}
  return _wcValenceMap;
}

// v27: subCat倒排索引(大中小路由P0) — 触发词 → Set(mode/subCat)
// 用于Phase T scoring前: 检测输入文本命中哪些subCat → 命中subCat内术语得1.5x boost
let _subCatTriggers = null;
function _getSubCatTriggers() {
  if (_subCatTriggers) return _subCatTriggers;
  _subCatTriggers = new Map(); // 触发词 → Set(mode/subCat)
  try {
    const actLib = _getActivationTerms();
    for (const [mode, dims] of Object.entries(actLib)) {
      if (mode.startsWith("_")) continue;
      for (const [subCat, terms] of Object.entries(dims)) {
        if (typeof terms !== "object" || Array.isArray(terms)) continue;
        for (const [, body] of Object.entries(terms)) {
          if (!body || !body.concepts) continue;
          for (const c of body.concepts) {
            const key = c.toLowerCase();
            if (!_subCatTriggers.has(key)) _subCatTriggers.set(key, new Set());
            _subCatTriggers.get(key).add(`${mode}/${subCat}`);
          }
        }
      }
    }
  } catch {}
  return _subCatTriggers;
}

/** @contract 返回: { [mode]: { [dim]: { [term]: TermMeta } } } — F1拆分AT优先+主AT eligible=false
 *  @consumers p1_phaseT.mjs(圈内匹配), p1_legacy.mjs(Phase B), _getMomentExpandIdx(grep "function _getMomentExpandIdx")
 *  @breaking 改返回格式→7处消费方全崩 */
function _getActivationTerms() {
  if (_activationTerms) return _activationTerms;
  let zhBase = {};
  try {
    const p = path.join(__sdp_dirname, "activation_terms.json");
    if (fs.existsSync(p)) zhBase = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}
  let enBase = null;
  try {
    const pen = path.join(__sdp_dirname, "activation_terms_en.json");
    if (fs.existsSync(pen)) enBase = JSON.parse(fs.readFileSync(pen, "utf-8"));
  } catch {}
  if (enBase) {
    for (const mode of ["chat", "code", "work", "airp"]) {
      if (!enBase[mode]) continue;
      if (!zhBase[mode]) zhBase[mode] = {};
      for (const cat of Object.keys(enBase[mode])) {
        if (!zhBase[mode][cat]) zhBase[mode][cat] = {};
        for (const term of Object.keys(enBase[mode][cat])) {
          zhBase[mode][cat][term] = enBase[mode][cat][term];
        }
      }
    }
  }
  // B1 fix 20260508: code专属词池 activation_terms_code.json 接入
  // 凛倾依据: 4mode_v3评分 §6 问题1 "建立独立code专属词池,硬断chat/psychology维度"
  // 修复: c202/c208/c216 出现 chat psychology 词 (全或无思维/音乐唤记忆/核心信念模式) 的根因
  try {
    const pCode = path.join(__sdp_dirname, "activation_terms_code.json");
    if (fs.existsSync(pCode)) {
      const codeTerms = JSON.parse(fs.readFileSync(pCode, "utf-8"));
      if (!zhBase["code"]) zhBase["code"] = {};
      // 专属词池: activation_terms_code.json 中的分类直接注入, 不被 chat 污染
      for (const cat of Object.keys(codeTerms)) {
        const poolKey = `code:${cat}`;
        if (!zhBase["code"][poolKey]) zhBase["code"][poolKey] = {};
        for (const [term, meta] of Object.entries(codeTerms[cat])) {
          if (typeof meta === "object") {
            const existing = zhBase["code"][poolKey][term];
            if (!existing) {
              zhBase["code"][poolKey][term] = meta;
            } else {
              // F1: 拆分AT精标数据覆盖主AT（axes_47/l1_summary/concepts/eligible/bridge_to）
              if (meta.axes_47) existing.axes_47 = meta.axes_47;
              if (meta.l1_summary) existing.l1_summary = meta.l1_summary;
              if (meta.concepts) existing.concepts = meta.concepts;
              if (meta.bridge_to !== undefined) existing.bridge_to = meta.bridge_to;
              if (meta.output_eligible !== undefined) existing.output_eligible = meta.output_eligible;
              if (meta.pe !== undefined) existing.pe = meta.pe;
            }
          } else if (!zhBase["code"][poolKey][term]) {
            zhBase["code"][poolKey][term] = { pe: 0.7, _codeSrc: cat };
          }
        }
      }
    }
  } catch {}
  // P0-E #4 fix 20260508: airp专属词池 activation_terms_airp.json 接入
  // 仿照 B1 fix (activation_terms_code.json) 风格
  // 依据: 新增 scene:accompany 词条 (陪伴启动场景/长期陪伴时间线/情感共振存档场景等)
  // 必须注入到 _actLib["airp"], 否则 _termToDim 找不到, transfer_index 命中无效
  try {
    const pAirp = path.join(__sdp_dirname, "activation_terms_airp.json");
    if (fs.existsSync(pAirp)) {
      const airpTerms = JSON.parse(fs.readFileSync(pAirp, "utf-8"));
      if (!zhBase["airp"]) zhBase["airp"] = {};
      for (const cat of Object.keys(airpTerms)) {
        if (!zhBase["airp"][cat]) zhBase["airp"][cat] = {};
        for (const [term, meta] of Object.entries(airpTerms[cat])) {
          if (typeof meta === "object") {
            const existing = zhBase["airp"][cat][term];
            if (!existing) { zhBase["airp"][cat][term] = meta; }
            else { if (meta.axes_47) existing.axes_47 = meta.axes_47; if (meta.l1_summary) existing.l1_summary = meta.l1_summary; if (meta.concepts) existing.concepts = meta.concepts; if (meta.bridge_to !== undefined) existing.bridge_to = meta.bridge_to; if (meta.output_eligible !== undefined) existing.output_eligible = meta.output_eligible; if (meta.pe !== undefined) existing.pe = meta.pe; }
          } else if (!zhBase["airp"][cat][term]) { zhBase["airp"][cat][term] = { pe: 0.7 }; }
        }
      }
    }
  } catch {}
  // P0-C fix 20260515: chat专属词池 activation_terms_chat.json 接入
  // 仿照 airp fix 风格: 30 categories (940 terms), 含 10 个独有 subCat
  // (narrative:emotional_arc_zh/emotion:connection/cognitive:reflection 等)
  // 不覆盖主词库已有词条, 只补充新 cat 和新 term
  try {
    const pChat = path.join(__sdp_dirname, "activation_terms_chat.json");
    if (fs.existsSync(pChat)) {
      const chatTerms = JSON.parse(fs.readFileSync(pChat, "utf-8"));
      if (!zhBase["chat"]) zhBase["chat"] = {};
      for (const cat of Object.keys(chatTerms)) {
        if (!zhBase["chat"][cat]) zhBase["chat"][cat] = {};
        for (const [term, meta] of Object.entries(chatTerms[cat])) {
          if (typeof meta === "object") {
            const existing = zhBase["chat"][cat][term];
            if (!existing) { zhBase["chat"][cat][term] = meta; }
            else { if (meta.axes_47) existing.axes_47 = meta.axes_47; if (meta.l1_summary) existing.l1_summary = meta.l1_summary; if (meta.concepts) existing.concepts = meta.concepts; if (meta.bridge_to !== undefined) existing.bridge_to = meta.bridge_to; if (meta.output_eligible !== undefined) existing.output_eligible = meta.output_eligible; if (meta.pe !== undefined) existing.pe = meta.pe; }
          } else if (!zhBase["chat"][cat][term]) { zhBase["chat"][cat][term] = { pe: 0.7 }; }
        }
      }
    }
  } catch {}
  // P0-C fix 20260515: work专属词池 activation_terms_work.json 接入
  // 17 categories (611 terms), 含 4 个独有 subCat
  // (team:management_practical/negotiation:strategy/decision:framework/team:management_analysis)
  // 不覆盖主词库已有词条, 只补充新 cat 和新 term
  try {
    const pWork = path.join(__sdp_dirname, "activation_terms_work.json");
    if (fs.existsSync(pWork)) {
      const workTerms = JSON.parse(fs.readFileSync(pWork, "utf-8"));
      if (!zhBase["work"]) zhBase["work"] = {};
      for (const cat of Object.keys(workTerms)) {
        if (!zhBase["work"][cat]) zhBase["work"][cat] = {};
        for (const [term, meta] of Object.entries(workTerms[cat])) {
          if (typeof meta === "object") {
            const existing = zhBase["work"][cat][term];
            if (!existing) { zhBase["work"][cat][term] = meta; }
            else { if (meta.axes_47) existing.axes_47 = meta.axes_47; if (meta.l1_summary) existing.l1_summary = meta.l1_summary; if (meta.concepts) existing.concepts = meta.concepts; if (meta.bridge_to !== undefined) existing.bridge_to = meta.bridge_to; if (meta.output_eligible !== undefined) existing.output_eligible = meta.output_eligible; if (meta.pe !== undefined) existing.pe = meta.pe; }
          } else if (!zhBase["work"][cat][term]) { zhBase["work"][cat][term] = { pe: 0.7 }; }
        }
      }
    }
  } catch {}
  // Step 0.2: 词库4层分类注入meta._4layer (词库侧5868术语已分类, 代码侧消费)
  // 来源: _get4layerLookup() 读4个JSON → term→{axis, dim, subCat}
  // 消费: T4.5a _classifyTermLayer先查meta._4layer, 替代部分运行时Jaccard
  const _layerLookup = _get4layerLookup();
  if (_layerLookup.size > 0) {
    for (const mode of Object.keys(zhBase)) {
      if (!zhBase[mode] || typeof zhBase[mode] !== "object") continue;
      for (const cat of Object.keys(zhBase[mode])) {
        if (!zhBase[mode][cat] || typeof zhBase[mode][cat] !== "object") continue;
        for (const term of Object.keys(zhBase[mode][cat])) {
          const li = _layerLookup.get(term);
          if (li) {
            const m = zhBase[mode][cat][term];
            if (typeof m === "object" && m !== null) {
              m._4layer = li;
            }
          }
        }
      }
    }
  }
  // BUG1修复: per-mode的output_eligible=false必须跨category生效
  // 问题: 同术语在主AT(cat A)和per-mode(cat B)各有一份, per-mode标false但主AT的那份仍true
  // 修法: 收集所有eligible=false的术语名, 全mode全category统一标false
  const _ineligibleTerms = new Set();
  for (const mode of Object.keys(zhBase)) {
    if (!zhBase[mode] || typeof zhBase[mode] !== "object") continue;
    for (const cat of Object.keys(zhBase[mode])) {
      if (!zhBase[mode][cat] || typeof zhBase[mode][cat] !== "object") continue;
      for (const [term, meta] of Object.entries(zhBase[mode][cat])) {
        if (typeof meta === "object" && meta?.output_eligible === false) {
          _ineligibleTerms.add(`${mode}::${term}`);
        }
      }
    }
  }
  if (_ineligibleTerms.size > 0) {
    for (const mode of Object.keys(zhBase)) {
      if (!zhBase[mode] || typeof zhBase[mode] !== "object") continue;
      for (const cat of Object.keys(zhBase[mode])) {
        if (!zhBase[mode][cat] || typeof zhBase[mode][cat] !== "object") continue;
        for (const [term, meta] of Object.entries(zhBase[mode][cat])) {
          if (_ineligibleTerms.has(`${mode}::${term}`) && typeof meta === "object") {
            meta.output_eligible = false;
          }
        }
      }
    }
  }
  // F1: 拆分AT优先——主AT独有术语(不在拆分AT中)强制eligible=false
  // 拆分AT有精标数据(axes_47/l1_summary/eligible)，主AT独有术语可能是克隆/无标注的
  const _perModeFiles = { chat: "activation_terms_chat.json", code: "activation_terms_code.json", airp: "activation_terms_airp.json", work: "activation_terms_work.json" };
  const _perModeTermSets = {};
  for (const [mode, fn] of Object.entries(_perModeFiles)) {
    _perModeTermSets[mode] = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, fn), "utf-8"));
      for (const terms of Object.values(raw)) {
        if (typeof terms === "object") for (const t of Object.keys(terms)) _perModeTermSets[mode].add(t);
      }
    } catch {}
  }
  for (const mode of Object.keys(zhBase)) {
    if (!zhBase[mode] || !_perModeTermSets[mode]) continue;
    const perSet = _perModeTermSets[mode];
    if (perSet.size === 0) continue;
    for (const cat of Object.keys(zhBase[mode])) {
      if (!zhBase[mode][cat] || typeof zhBase[mode][cat] !== "object") continue;
      for (const [term, meta] of Object.entries(zhBase[mode][cat])) {
        if (typeof meta === "object" && !perSet.has(term) && meta.output_eligible === undefined) {
          meta.output_eligible = false;
        }
      }
    }
  }
  _activationTerms = zhBase;
  return _activationTerms;
}

// ── 信号词库加载器(替代hardcode正则) ──
// 凛倾: "正则太僵硬,需要一个库" / "面向全球用户" / "男女中英日韩都需要"
// 5个JSON合并→4个Set: chatSet(中2368+英2199+日韩841), workSet(1314), greetingSet, airpSuppressSet
function _getSignalLexicons() {
  if (_signalLexicons) return _signalLexicons;
  const chatWords = [];
  const workWords = [];
  const greetingWords = [];
  const airpSuppressWords = [];
  const _tryLoad = (name) => {
    try {
      const p = path.join(__sdp_dirname, name);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {}
    return null;
  };
  // 1) base signal_lexicons.json
  const base = _tryLoad("signal_lexicons.json");
  if (base) {
    for (const lang of ["zh", "en", "ja", "ko"]) {
      if (base.chat_signals?.[lang]) chatWords.push(...base.chat_signals[lang]);
      if (base.greeting_signals?.[lang]) greetingWords.push(...base.greeting_signals[lang]);
    }
    for (const lang of ["zh", "en"]) {
      if (base.work_signals?.[lang]) workWords.push(...base.work_signals[lang]);
    }
    if (base.airp_suppress?.terms) airpSuppressWords.push(...base.airp_suppress.terms);
  }
  // 2) chat_signal_lexicon.json (中文2368词29类)
  const chatZh = _tryLoad("chat_signal_lexicon.json");
  if (chatZh) {
    for (const [k, v] of Object.entries(chatZh)) {
      if (k === "meta" || !Array.isArray(v)) continue;
      chatWords.push(...v);
    }
  }
  // 3) en_chat_signal_lexicon.json (英文2199词10类)
  const chatEn = _tryLoad("en_chat_signal_lexicon.json");
  if (chatEn) {
    for (const [k, v] of Object.entries(chatEn)) {
      if (k === "meta" || !Array.isArray(v)) continue;
      chatWords.push(...v);
    }
  }
  // 4) ja_ko_chat_signal_lexicon.json (日韩841词12类)
  const chatJaKo = _tryLoad("ja_ko_chat_signal_lexicon.json");
  if (chatJaKo) {
    for (const [k, v] of Object.entries(chatJaKo)) {
      if (k === "meta" || !Array.isArray(v)) continue;
      chatWords.push(...v);
    }
  }
  // 5) work_signal_lexicon.json (工作1314词13类)
  const workFull = _tryLoad("work_signal_lexicon.json");
  if (workFull) {
    for (const [k, v] of Object.entries(workFull)) {
      if (k === "_meta" || !Array.isArray(v)) continue;
      workWords.push(...v);
    }
  }
  // 6) airp_signal_lexicon.json (v33精简版~574词, 只含airp高度特征词)
  // 去除通用情感词(心动/喜欢/陪伴/孤独等), 防止与chatSet干扰(v30/v31教训)
  const airpWords = [];
  const airpFull = _tryLoad("airp_signal_lexicon.json");
  if (airpFull) {
    for (const [k, v] of Object.entries(airpFull)) {
      if (k === "_meta" || !Array.isArray(v)) continue;
      airpWords.push(...v);
    }
  }
  // 去重后建Set(英文统一小写)
  const _norm = (w) => /^[a-zA-Z\s]+$/.test(w) ? w.toLowerCase().trim() : w.trim();
  _signalLexicons = {
    chatSet: new Set(chatWords.filter(Boolean).map(_norm)),
    workSet: new Set(workWords.filter(Boolean).map(_norm)),
    greetingSet: new Set(greetingWords.filter(Boolean).map(_norm)),
    airpSuppressSet: new Set(airpSuppressWords.filter(Boolean).map(_norm)),
    airpSet: new Set(airpWords.filter(Boolean).map(_norm)),
  };
  return _signalLexicons;
}

// P9 fix 20260509: _lexMatchAny 0 调用死代码删除 (拆分前审查 §2 死代码 #2)

// 滑窗词库匹配(计数版): 返回命中词数而非布尔值, 用于chat/work信号强度比较
function _lexCountMatches(text, wordSet) {
  if (!text || !wordSet?.size) return 0;
  let count = 0;
  const seen = new Set();
  // 英文token匹配
  const enTokens = text.match(/[a-zA-Z']+(?:\s+[a-zA-Z']+){0,3}/g) || [];
  for (const phrase of enTokens) {
    const lower = phrase.toLowerCase();
    if (wordSet.has(lower) && !seen.has(lower)) { seen.add(lower); count++; }
    for (const w of lower.split(/\s+/)) {
      if (w.length >= 2 && wordSet.has(w) && !seen.has(w)) { seen.add(w); count++; }
    }
  }
  // CJK滑窗(贪心最长匹配, 避免子串重复计数)
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch < 0x2E80) { i++; continue; }
    let bestLen = 0;
    for (let len = Math.min(8, text.length - i); len >= 1; len--) {
      const sub = text.slice(i, i + len);
      if (wordSet.has(sub) && !seen.has(sub)) { bestLen = len; break; }
    }
    if (bestLen > 0) {
      seen.add(text.slice(i, i + bestLen));
      count++;
      i += bestLen;
    } else {
      i++;
    }
  }
  return count;
}

// AIRP安全检查: 术语名是否包含抑制词(子串匹配)
function _airpSuppressCheck(termName, suppressSet) {
  for (const w of suppressSet) {
    if (termName.includes(w)) return true;
  }
  return false;
}

// AIRP作品→技法映射(Gemini标注): 作品名→{techniques, mood, scene_type}
let _airpTechniqueMap = null;
function _getAirpTechniqueMap() {
  if (_airpTechniqueMap) return _airpTechniqueMap;
  try {
    const p = path.join(__sdp_dirname, "airp_work_technique_map.json");
    if (fs.existsSync(p)) {
      _airpTechniqueMap = JSON.parse(fs.readFileSync(p, "utf-8"));
      return _airpTechniqueMap;
    }
  } catch {}
  _airpTechniqueMap = {};
  return _airpTechniqueMap;
}
// 65#: keyword → 字段补全 (角色/作品/场景片段 → 主AI看到完整画像)
// 凛倾原话: "输出之后系统补全后面的信息. 比如角色鹿目圆,系统会补全,性格是这样的,在什么作品,有什么改变,人格,情绪轮盘,abc等"
let _momentExpandIdx = null;
function _getMomentExpandIdx() {
  if (_momentExpandIdx) return _momentExpandIdx;
  _momentExpandIdx = new Map();
  try {
    const at = _getActivationTerms();
    function* walk(o, mode) {
      for (const [k, v] of Object.entries(o)) {
        if (k === "_meta") continue;
        if (typeof v === "object" && v && !Array.isArray(v)) {
          if ("pe" in v && "concepts" in v) yield { key: k, data: v, mode };
          else yield* walk(v, mode || k);
        }
      }
    }
    for (const item of walk(at, null)) {
      // 名场面长 key: 长度>=6 (汉字) 且 concepts >= 4 (足够展开)
      const tags = ["游戏名场面", "动漫名场面", "小说名场面", "名场面"];
      const concepts = (item.data.concepts || []).filter(c => !tags.includes(c));
      if (item.key.length >= 6 && concepts.length >= 4) {
        _momentExpandIdx.set(item.key, {
          concepts: concepts.slice(0, 5).join("/"),
          mode: item.mode || "",
        });
      }
    }
  } catch {}
  return _momentExpandIdx;
}
let _charExpandIdx = null;
function _getCharExpandIdx() {
  if (_charExpandIdx) return _charExpandIdx;
  _charExpandIdx = new Map();
  try {
    const cp = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "character_psychology.json"), "utf-8"));
    for (const [name, data] of Object.entries(cp.characters || {})) {
      const expansion = {
        type: "character",
        work: data.work || "",
        psychology: data.emotional_core || "",
        archetype: data.archetype || "",
        abc: data.abc_belief || "",
        attachment: data.attachment || "",
        defense: (data.defense || []).slice(0, 3).map(d => _aliasMap(d.replace(/\s*\([^)]*\)/g, "").trim())).join("/"),
        plutchik: (data.plutchik?.primary || []).join("/"),
        maps_to: (data.maps_to || []).slice(0, 4).join(","),
      };
      _charExpandIdx.set(name, expansion);
      for (const alias of (data.aliases || [])) {
        if (!_charExpandIdx.has(alias)) _charExpandIdx.set(alias, expansion);
      }
    }
  } catch {}
  return _charExpandIdx;
}
function _buildExpansions(terms, inputCandidates) {
  const charIdx = _getCharExpandIdx();
  const techMap = _getAirpTechniqueMap();
  const momentIdx = _getMomentExpandIdx();
  const out = [];
  const seenTerm = new Set();
  const seenChar = new Set();
  const seenWork = new Set();
  const all = [...(terms || []), ...(inputCandidates || [])];
  for (const term of all) {
    if (!term || seenTerm.has(term)) continue;
    seenTerm.add(term);
    if (charIdx.has(term)) {
      const e = charIdx.get(term);
      const charKey = `${e.work}|${e.psychology}`;
      if (seenChar.has(charKey)) continue;
      seenChar.add(charKey);
      // 187# alias: maps_to 字段也走 alias (避免主 AI 看到主观词如 "离弃恐惧/崩溃边缘体验")
      const eAliased = { ...e };
      if (e.maps_to) {
        eAliased.maps_to = e.maps_to.split(",").map(t => _aliasMap(t.trim())).join(",");
      }
      out.push({ type: "character", key: term, fields: eAliased });
      continue;
    }
    if (techMap[term]) {
      if (seenWork.has(term)) continue;
      seenWork.add(term);
      const w = techMap[term];
      out.push({ type: "work", key: term, fields: {
        techniques: (w.techniques || []).slice(0, 3).join("/"),
        mood: w.mood || "",
        scene_type: w.scene_type || "",
      }});
      continue;
    }
    if (momentIdx.has(term)) {
      const m = momentIdx.get(term);
      out.push({ type: "moment", key: term, fields: { concepts: m.concepts } });
    }
  }
  return out.slice(0, 3);
}

// Fan Effect (Anderson 1974) + CSLS (Lample 2018) hub统计
function _getHubStats() {
  if (_hubStats) return _hubStats;
  try {
    const p = path.join(__sdp_dirname, "hub_stats.json");
    if (fs.existsSync(p)) {
      _hubStats = JSON.parse(fs.readFileSync(p, "utf-8"));
      return _hubStats;
    }
  } catch {}
  _hubStats = { fanMap: {}, cslsR: {} };
  return _hubStats;
}

// ConceptNet因果valence(4746词: word→{neg,pos,dir})
function _getCnValence() {
  if (_cnValence) return _cnValence;
  try {
    const p = path.join(__sdp_dirname, "conceptnet_valence.json");
    if (fs.existsSync(p)) { _cnValence = JSON.parse(fs.readFileSync(p, "utf-8")); return _cnValence; }
  } catch {}
  _cnValence = {};
  return _cnValence;
}

// IDEM习语词典(5000条英文习语→情感维度映射)
function _getIdiomLexicon() {
  if (_idiomLexicon) return _idiomLexicon;
  try {
    const p = path.join(__sdp_dirname, "idiom_lexicon.json");
    if (fs.existsSync(p)) {
      _idiomLexicon = JSON.parse(fs.readFileSync(p, "utf-8"));
      return _idiomLexicon;
    }
  } catch {}
  _idiomLexicon = {};
  return _idiomLexicon;
}

// 框架识别层(97号MD: trigger匹配→框架名+方向词)
function _getFrameworkPatterns() {
  if (_frameworkPatterns) return _frameworkPatterns;
  try {
    const p = path.join(__sdp_dirname, "framework_patterns.json");
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      // 构建倒排索引: trigger词→[{mode,name,direction,cross_domain}]
      const idx = new Map();
      for (const [mode, frameworks] of Object.entries(raw)) {
        if (mode === "_meta") continue;
        for (const [name, f] of Object.entries(frameworks)) {
          for (const t of (f.trigger || [])) {
            if (!idx.has(t)) idx.set(t, []);
            idx.get(t).push({ mode, name, direction: f.direction || [], cross: f.cross_domain || {} });
          }
        }
      }
      _frameworkPatterns = idx;
      return idx;
    }
  } catch {}
  _frameworkPatterns = new Map();
  return _frameworkPatterns;
}

// P9 fix 20260509: _getFrameworkCentroids 0 调用死代码删除 (framework_centroids 未接入 Phase B, 拆分前审查 §2 死代码 #3)

// 情绪方向向量(6方向×300维,v4.0空间发散用)
function _getEmotionDirections() {
  if (_emotionDirections) return _emotionDirections;
  try {
    const p = path.join(__sdp_dirname, "emotion_directions.json");
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      _emotionDirections = {};
      for (const [name, data] of Object.entries(raw)) {
        const arr = new Float32Array(data.direction);
        let nm = 0;
        for (let i = 0; i < arr.length; i++) nm += arr[i] * arr[i];
        nm = Math.sqrt(nm);
        if (nm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= nm;
        _emotionDirections[name] = arr;
      }
      return _emotionDirections;
    }
  } catch {}
  _emotionDirections = null;
  return null;
}

// POS词性向量(38K词×8维,BERT-style meta通道)
function _getPosVectors() {
  if (_posVectors) return _posVectors;
  try {
    const p = path.join(__sdp_dirname, "pos_vectors.json");
    if (fs.existsSync(p)) {
      _posVectors = JSON.parse(fs.readFileSync(p, "utf-8"));
      return _posVectors;
    }
  } catch {}
  _posVectors = {};
  return _posVectors;
}

function _getCooccurSeed() {
  if (_cooccurSeed) return _cooccurSeed;
  try {
    const p = path.join(__sdp_dirname, "cooccur_seed.json");
    if (fs.existsSync(p)) {
      _cooccurSeed = JSON.parse(fs.readFileSync(p, "utf-8"));
      diag.log(`[selfDrivenP1] cooccur_seed loaded: ${Object.keys(_cooccurSeed).length} pairs`);
      return _cooccurSeed;
    }
  } catch (e) { diag.warn("[selfDrivenP1] cooccur_seed load fail:", e.message); }
  _cooccurSeed = {};
  return _cooccurSeed;
}
function _getCooccurInvIdx() {
  if (_cooccurInvIdx) return _cooccurInvIdx;
  const cooccur = _getCooccurSeed();
  const idx = new Map();
  for (const [pair, count] of Object.entries(cooccur)) {
    const [a, b] = pair.split("|");
    if (!a || !b) continue;
    if (!idx.has(a)) idx.set(a, []);
    if (!idx.has(b)) idx.set(b, []);
    idx.get(a).push([b, count]);
    idx.get(b).push([a, count]);
  }
  // 每词按 count 降序(取 top-K 时只看前几个)
  for (const arr of idx.values()) arr.sort((x, y) => y[1] - x[1]);
  _cooccurInvIdx = idx;
  diag.log(`[selfDrivenP1] cooccur_inv_idx built: ${idx.size} words`);
  return idx;
}

// §16.35 发散测试发现: lccc seed 里高频虚词跟一切共现, 扩散出"不是/什么/知道"=纯噪声
// 这些词在 vocab.mjs STOP_WORDS 之外(因为作为 query 词本身有用), 但作为 cooccur 扩散目标无意义
// 从cooccur_stop.json加载(散词层噪声过滤: "真的/今天/角色"等高频无信息共现词)
let COOCCUR_STOP = null;
function _getCooccurStop() {
  if (COOCCUR_STOP) return COOCCUR_STOP;
  try { COOCCUR_STOP = new Set(JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "cooccur_stop.json"), "utf-8"))); }
  catch { COOCCUR_STOP = new Set(); }
  return COOCCUR_STOP;
}
_getCooccurStop();

// ── 资源加载: cognitive_bias + sensorimotor + xanew (lab已验证，合入生产) ──
let _cognitiveBiasCache = null;
function _getCognitiveBias() {
  if (!_cognitiveBiasCache) { try { _cognitiveBiasCache = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "cognitive_bias_lexicon.json"), "utf-8")); } catch { _cognitiveBiasCache = {}; } }
  return _cognitiveBiasCache;
}
let _sensorimotorZhCache = null;
function _getSensorimotorZh() {
  if (!_sensorimotorZhCache) { try { _sensorimotorZhCache = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "sensorimotor_zh.json"), "utf-8")); } catch { _sensorimotorZhCache = {}; } }
  return _sensorimotorZhCache;
}
let _xanewVadCache = null;
function _getXanewVad() {
  if (!_xanewVadCache) { try { _xanewVadCache = JSON.parse(fs.readFileSync(path.join(__sdp_dirname, "xanew_vad.json"), "utf-8")); } catch { _xanewVadCache = {}; } }
  return _xanewVadCache;
}

// 高频噪声词(ACT-R Fan效应: 高扇出词信息量≈0), 用于hitNodes过滤和guide动态编译
const HIT_NOISE = new Set(); // 172#64: 移到 lib/polarity_lexicon.json#recall_noise
function _hitNoise(w) { return _polSet("recall_noise").has(w); }

// ====== 尾部工具函数 ======
const SLANG_HYPERBOLE_WHITELIST = [
  /累死了/, /笑死/, /气死了/, /烦死了/, /困死了/, /热死/, /冷死/,
  /要死了/, /疯了/, /绝了/, /醉了/, /尴尬死/, /高兴死了/, /开心死了/,
  /香死了/, /好吃死了/, /漂亮死了/, /可爱死了/, /帅死了/,
];
function hasSlangHyperbole(text) {
  return SLANG_HYPERBOLE_WHITELIST.some(re => re.test(text));
}

// 反方 LLM 学者 D1: 否定 + 情感词组合应取反, 不能并列累加
// "我不累" 应抵消"累"的负向, 检测否定词紧邻情感词的窗口(2 字内)
function applyNegationScope(text, emoNegSet) {
  // 简化: 检测"不/没/别/无/未"+情感词的紧邻组合, 若存在则减 1 个 emoNeg 命中
  let cancelled = 0;
  const negPatterns = [/不[累烦怒哀难急忧惧]/, /没[累烦怒哀难急忧惧]/, /别[难烦累]/, /无[忧愁惧]/];
  for (const p of negPatterns) {
    if (p.test(text)) cancelled++;
  }
  return cancelled;
}

function detectEscalationSignals(text, chatHistory, mainResult) {
  // 凛倾§16.33 "广度对不上" — 改用资源库语义词集而非硬正则
  // escalationLex 已扩展词林同小类 + DLUT 情感 + 否定词 → 词集 14-300+(vs 之前每信号 6-8 词)
  const signals = [];
  const t = String(text || "");
  const hist = Array.isArray(chatHistory) ? chatHistory : [];
  const queryWords = (mainResult?.words || []).filter(w => w && w.length >= 1);
  let lex;
  try { lex = getEscalationLex(); }
  catch { return signals; }

  // 反方用户专家 #3: 网络口语豁免预处理
  const slangHype = hasSlangHyperbole(t);
  // 反方 LLM 学者 D1: 否定范围
  const negCancelled = applyNegationScope(t, lex.emotion_neg);

  const inSet = (set) => queryWords.filter(w => set?.has?.(w));
  const inText = (set) => {
    let n = 0;
    for (const w of (set || [])) if (t.includes(w)) { n++; if (n >= 5) break; }
    return n;
  };

  // S1: 时间锚点 — 词林扩展(还记得/以前/第一次... + 同小类几十词)
  if (inSet(lex.timeAnchor).length >= 1 || inText(lex.timeAnchor) >= 1) signals.push("S1");

  // S2: 因果链推理(凛倾§16.32 "逻辑学强") — 词林因果类(因为/所以/导致+ 几十同义)
  const causalityHits = inSet(lex.causality);
  if (causalityHits.length >= 2 || (causalityHits.length >= 1 && hist.length >= 5)) signals.push("S2");

  // S3: 情感脉络 — DLUT 强烈贬义 + 模糊持续词("最近/这段时间/总是"等)
  // 反方用户/LLM 学者: 减去网络口语 + 否定范围 = 真实情感强度
  const emoNegRaw = inSet(lex.emotion_neg).length;
  const emoNegHits = Math.max(0, emoNegRaw - negCancelled - (slangHype ? 1 : 0));
  const hasFuzzyDuration = /最近|这段时间|不知道为什么|状态有点|感觉一直|总是|一直|老是|经常|常常/.test(t);
  const hasSharpTimeAnchor = /还记得|那天|那时候|上次|上回|第一次|当时/.test(t);
  if ((emoNegHits >= 2 || (emoNegHits >= 1 && hasFuzzyDuration)) && !hasSharpTimeAnchor) signals.push("S3");

  // S4: 多意图嵌套(凛倾§16.32 "跨度大") — 并列连词 ≥2 + 实体词 ≥3
  const conjHits = inSet(lex.conjunction);
  const realWords = queryWords.filter(w => w.length >= 2);
  const entityCount = realWords.filter(w => !lex.conjunction?.has?.(w) && !lex.causality?.has?.(w) && !lex.reasoning?.has?.(w)).length;
  if (conjHits.length >= 2 && entityCount >= 3) signals.push("S4");

  // S5: 兜底 — 自驱动召回稀疏 + 主题跳跃
  const matchedCount = mainResult?.candidates?.length || 0;
  if (matchedCount === 0 && hist.length >= 3) {
    const recentText = hist.slice(-3).map(m => m?.content || "").join(" ");
    if (realWords.length > 0) {
      const overlap = realWords.filter(w => recentText.includes(w)).length;
      if (overlap / realWords.length < 0.3) signals.push("S5");
    }
  }

  // S8: 历史精确查找
  if (/之前|我们讨论过|做过没|查找|找一下|看看以前|前面说的|那时候说/.test(t)) signals.push("S8");

  // S9: 类比传播 — 词林比较类
  if (inSet(lex.compare).length >= 1 || /想个|创意|灵感|比喻/.test(t)) signals.push("S9");

  // S_irony: 反讽 — 当前句负面 (DLUT 或网络口语) + 近 5 轮有褒义
  // 用网络口语豁免表中"字面贬义但口语夸张"的词当反讽信号
  const slangNegHit = slangHype || /崩溃|绝望|完蛋|无语死了/.test(t);
  if ((emoNegHits >= 1 || slangNegHit) && hist.length >= 2) {
    const recent5 = hist.slice(-5).map(m => m?.content || "").join(" ");
    let recentPosCount = 0;
    for (const pos of lex.emotion_pos) {
      if (recent5.includes(pos)) { recentPosCount++; if (recentPosCount >= 2) break; }
    }
    // 兜底: 网络口语开心词
    if (/开心|高兴|有趣|好玩|笑死|哈哈|喜欢|快乐|完成|成功/.test(recent5)) recentPosCount++;
    if (recentPosCount >= 2) signals.push("S_irony");
  }

  // S_net: 实时联网(时间敏感词不在词林标准类, 保留小词集)
  if (/最新|刚出|今天|现在流行|最近的梗|新出|热门|最近发生|刚刚|当下/.test(t)) signals.push("S_net");

  // S_complex: 复杂多步推理 — 词林推理类 ≥2 OR ≥1 + 因果/连词
  const reasoningHits = inSet(lex.reasoning).length;
  if (reasoningHits >= 2 || (reasoningHits >= 1 && (causalityHits.length >= 1 || conjHits.length >= 1))) {
    signals.push("S_complex");
  }

  // S_negation: 否定语句 — 否定词 ≥2 (chinese_dictionary 1517 否定词, 凛倾"广度")
  const negHits = inSet(lex.negation).length;
  if (negHits >= 2) signals.push("S_negation");

  return signals;
}

// ====== 工具函数 ======

function extractLatestUserMessage(arg) {
  // 优先取当前输入(不在chat_log里), 然后fallback到chat_log最后一条user消息
  if (arg?.content && typeof arg.content === "string" && arg.content.trim()) return arg.content;
  if (arg?.user_message && typeof arg.user_message === "string") return arg.user_message;
  const log = arg?.chat_log || [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]?.role === "user") return log[i].content || "";
  }
  return "";
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ====== setter 函数 (供 diverge 修改模块级缓存变量) ======
// ES module: 只有声明文件可以修改 let 变量, diverge 通过这些 setter 修改
function _setAxisLexNbCache(v) { _axisLexNbCache = v; }
function _setEnDimCache(v) { _enDimCache = v; }
function _setSentimentZh(v) { _sentimentZh = v; }
function _setSentimentEn(v) { _sentimentEn = v; }
function _setTvSubCatValenceCache(v) { _tvSubCatValenceCache = v; }
function _setOverusedPenaltyCache(v) { _overusedPenaltyCache = v; }
function _setCnCauseIdx(v) { _cnCauseIdx = v; }
function _setTransferVocab(v) { _transferVocab = v; }
function _setEmbodiedCentroidCache(v) { _embodiedCentroidCache = v; }
function _setStrategyFnCache(v) { _strategyFnCache = v; }
function _setSwowZhCache(v) { _swowZhCache = v; }

// ====== scoring 函数依赖的词汇常量 (diverge + 3files 共用) ======
// 这些常量原在拆分前的主控单体文件(约 L7118-L7243, 行号为历史快照已失效), 拆分后需在 utils 声明供 diverge 和 3files 使用
const EMO_WORDS_NEG = ["累", "痛", "悲", "怕", "恨", "烦", "难", "苦", "孤独", "抑郁", "崩溃"];
const EMO_WORDS_POS = ["开心", "喜欢", "爱", "棒", "好", "幸福", "兴奋"];
const TECH_WORDS = ["代码", "bug", "deadline", "项目", "ai", "function", "github", "提交", "测试", "记忆表格", "提示词", "思维链"];
const TIME_WORDS_FUTURE = ["以后", "未来", "终于", "永远", "一直", "下次", "下一", "10年", "20年"];
const TIME_WORDS_NOW = ["现在", "今天", "马上", "立刻", "刚才", "刚刚"];
const ACG_WORDS = ["小圆", "杏子", "晓美焰", "魔法少女", "vocaloid", "初音", "番剧", "二次元", "galgame", "airp", "角色卡", "立绘", "嘴硬", "傲娇"];

// ====== 300维向量运算工具 ======
function nbDot300(a, b) { let d = 0; for (let i = 0; i < 300; i++) d += a[i] * b[i]; return d; }
function nbCos300(a, b) {
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < 300; i++) { dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
  return (nA > 0 && nB > 0) ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
}
function nbCentroid300(vecs) {
  if (!vecs || vecs.length === 0) return null;
  const c = new Float32Array(300);
  for (const v of vecs) { for (let i = 0; i < 300; i++) c[i] += v[i]; }
  let norm = 0;
  for (let i = 0; i < 300; i++) { c[i] /= vecs.length; norm += c[i] * c[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 300; i++) c[i] /= norm;
  return c;
}

// ====== 4个从主控移入的 utils 函数 (a549dade 卡点修复) ======

// 工具: 计算文本含某 set 中的词数(早停 maxHits)
// MD出处: scoreRecord/computeTechEmotionAxis/computeACGAxis 共用
function countSetHits(text, set, maxHits) {
  if (!set || set.size === 0) return 0;
  let n = 0;
  for (const w of set) {
    if (text.includes(w)) {
      n++;
      if (n >= maxHits) return n;
    }
  }
  return n;
}

// self_eval 轴计算: 掌控/依赖词交叉振荡
// MD出处: 凛倾§16.34 词林扩散集合(control/dependent), detectEmergentAxes + scoreRecord 共用
const _CTRL_WORDS_FALLBACK = ["可以", "限制", "决定", "强", "聪明", "厉害", "做到", "搞定", "完成"];
const _DEP_WORDS_FALLBACK  = ["怕", "害怕", "失去", "需要你", "离不开", "笨", "做不到", "不行", "无能"];
function computeSelfEvalAxis(qText, memText) {
  const ctlSet = (() => { try { return getAxisLex().control; } catch { return null; } })();
  const depSet = (() => { try { return getAxisLex().dependent; } catch { return null; } })();
  const ctlCheck = ctlSet && ctlSet.size > _CTRL_WORDS_FALLBACK.length ? ctlSet : new Set(_CTRL_WORDS_FALLBACK);
  const depCheck = depSet && depSet.size > _DEP_WORDS_FALLBACK.length ? depSet : new Set(_DEP_WORDS_FALLBACK);
  let qCtl = 0, qDep = 0, mCtl = 0, mDep = 0;
  for (const w of ctlCheck) {
    if (qText.includes(w)) qCtl++;
    if (memText.includes(w)) mCtl++;
    if (qCtl >= 5 && mCtl >= 5) break;
  }
  for (const w of depCheck) {
    if (qText.includes(w)) qDep++;
    if (memText.includes(w)) mDep++;
    if (qDep >= 5 && mDep >= 5) break;
  }
  if (qCtl + qDep === 0 || mCtl + mDep === 0) return 0;
  const qSwing = qCtl > 0 && qDep > 0 ? 1 : 0;
  const mSwing = mCtl > 0 && mDep > 0 ? 1 : 0;
  if (qSwing && mSwing) return 1.0;
  if (qSwing || mSwing) return 0.6;
  return 0.3;
}

// 双信道融合: 主信道(括号外)60% + 副信道(括号内)40%
// MD出处: 149号 §1 凛倾"不取均值,保留张力"
function fuseDualChannels(mainResult, parenResult) {
  if (!parenResult) {
    return { ...mainResult, channelFusion: "main_only" };
  }
  return {
    main: mainResult,
    paren: parenResult,
    channelFusion: "dual",
    fusionWeight: { main: 0.6, paren: 0.4 },
    activatedNodes: [...mainResult.activatedNodes, ...parenResult.activatedNodes],
    candidates: [...mainResult.candidates, ...parenResult.candidates],
    words: [...(mainResult.words || []), ...(parenResult.words || [])],
    queryVec: mainResult.queryVec,
    cogSignals: mainResult.cogSignals,
    sceneRoute: mainResult.sceneRoute,
    emergentSignals: mainResult.emergentSignals,
    conjunctionSignal: mainResult.conjunctionSignal,
    moodProfile: mainResult.moodProfile,
    recallAnchors: mainResult.recallAnchors,
  };
}

// softmax 归一化(数值稳定版)
// MD出处: 凛倾§16.13 A QKV attention softmax 归一化
function softmax(values) {
  if (!values.length) return [];
  const max = Math.max(...values);
  const exps = values.map(v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map(e => e / sum);
}

function _runtimeCacheBucketSize(value) {
  if (value == null) return 0;
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value.length;
  return 0;
}

function _selfDrivenRuntimeCacheEntries() {
  return {
    bccDict: _bccDictCache,
    bccFreq: _bccFreqCache,
    polarityLex: _polarityLexCache,
    termAlias: _termAliasCache,
    valenceLex: _valenceLexCache,
    cooccurSeed: _cooccurSeed,
    axisLexNb: _axisLexNbCache,
    cooccurInv: _cooccurInvIdx,
    transferVocab: _transferVocab,
    hubStats: _hubStats,
    posVectors: _posVectors,
    idiomLexicon: _idiomLexicon,
    cnValence: _cnValence,
    frameworkPatterns: _frameworkPatterns,
    emotionDirections: _emotionDirections,
    frameworkCentroids: _frameworkCentroids,
    tvSubCatValence: _tvSubCatValenceCache,
    embodiedCentroid: _embodiedCentroidCache,
    wcValence: _wcValenceMap,
    sentimentZh: _sentimentZh,
    sentimentEn: _sentimentEn,
    cnCause: _cnCauseIdx,
    strategyFn: _strategyFnCache,
    enDim: _enDimCache,
    cogmechReverse: _cogmechReverse,
    embodiedWords: _embodiedWordsCache,
    swowZh: _swowZhCache,
    overusedPenalty: _overusedPenaltyCache,
    fourLayerLookup: _4layerLookupCache,
    termMeta: _termMetaCache,
    modeDirectionVector: _modeDirVecCache,
    activationTerms: _activationTerms,
    signalLexicons: _signalLexicons,
    memeIndex: _memeIndex,
    transferIndex: _transferIndex,
    airpTechnique: _airpTechniqueMap,
    momentExpand: _momentExpandIdx,
    characterExpand: _charExpandIdx,
    subCatTriggers: _subCatTriggers,
    cognitiveBias: _cognitiveBiasCache,
    sensorimotorZh: _sensorimotorZhCache,
    xanewVad: _xanewVadCache,
  };
}

function getSelfDrivenP1UtilsCacheStats() {
  const entries = _selfDrivenRuntimeCacheEntries();
  return {
    loaded: Object.values(entries).filter((value) => value != null).length,
    buckets: Object.values(entries).reduce((sum, value) => sum + _runtimeCacheBucketSize(value), 0),
    hotReloadMtimes: _hotReloadMtime.size,
    activationUsers: _actTermFreqByUser.size,
    tokenizerLoaded: !!_jiebaCut,
    cooccurStopBuckets: COOCCUR_STOP?.size || 0,
  };
}

function clearSelfDrivenP1UtilsCaches() {
  _bccDictCache = null;
  _bccFreqCache = null;
  _polarityLexCache = null;
  _termAliasCache = null;
  _valenceLexCache = null;
  _cooccurSeed = null;
  _axisLexNbCache = null;
  _cooccurInvIdx = null;
  _transferVocab = null;
  _hubStats = null;
  _posVectors = null;
  _idiomLexicon = null;
  _cnValence = null;
  _frameworkPatterns = null;
  _emotionDirections = null;
  _frameworkCentroids = null;
  _tvSubCatValenceCache = null;
  _embodiedCentroidCache = null;
  _wcValenceMap = null;
  _sentimentZh = null;
  _sentimentEn = null;
  _cnCauseIdx = null;
  _strategyFnCache = null;
  _enDimCache = null;
  _cogmechReverse = null;
  _embodiedWordsCache = null;
  _swowZhCache = null;
  _overusedPenaltyCache = null;
  _4layerLookupCache = null;
  _termMetaCache = null;
  _modeDirVecCache = null;
  _activationTerms = null;
  _signalLexicons = null;
  _memeIndex = null;
  _transferIndex = null;
  _airpTechniqueMap = null;
  _momentExpandIdx = null;
  _charExpandIdx = null;
  _subCatTriggers = null;
  _cognitiveBiasCache = null;
  _sensorimotorZhCache = null;
  _xanewVadCache = null;
  COOCCUR_STOP = null;
  _hotReloadMtime.clear();
  _lastHotReloadCheck = 0;
  _actTermFreqByUser.clear();
}

// ====== EXPORT ======
export {
  // 全局缓存 Map 变量
  _cooccurSeed, _axisLexNbCache, _cooccurInvIdx, _transferVocab,
  _hubStats, _posVectors, _idiomLexicon, _cnValence,
  _frameworkPatterns, _emotionDirections, _frameworkCentroids,
  _tvSubCatValenceCache, _embodiedCentroidCache, _wcValenceMap,
  _sentimentZh, _sentimentEn, _cnCauseIdx, _strategyFnCache,
  _enDimCache, _cogmechReverse, _embodiedWordsCache,
  _swowZhCache, _overusedPenaltyCache, _4layerLookupCache, _termMetaCache, _modeDirVecCache,
  _activationTerms, _signalLexicons, _memeIndex, _transferIndex,
  _airpTechniqueMap, _momentExpandIdx, _charExpandIdx,
  _subCatTriggers, _bccDictCache, _bccFreqCache, _polarityLexCache,
  _termAliasCache, _valenceLexCache, _actTermFreqByUser,
  _hotReloadFiles, _hotReloadMtime, _lastHotReloadCheck, _HOT_RELOAD_INTERVAL,
  COOCCUR_STOP, HIT_NOISE,
  // 缓存加载函数
  _getBccDict, _getBccFreq, _isEnWord, // P9 fix: _isPosNoise 删除 (死代码)
  _getPolarityLex, _polSet, _getTermAlias, _aliasMap, _getValenceLex,
  _getTermMeta, _getModeDirVec, _checkHotReload, _getActTermFreq, _get4layerLookup,
  _getMemeIndex, _getTransferIndex, _getCogmechReverse, _getEmbodiedWords,
  _getWcValenceMap, _getSubCatTriggers, _getActivationTerms, _getSignalLexicons,
  _lexCountMatches, _airpSuppressCheck, _getAirpTechniqueMap, // P9 fix: _lexMatchAny 删除 (死代码)
  _getMomentExpandIdx, _getCharExpandIdx, _buildExpansions, _getHubStats,
  _getCnValence, _getIdiomLexicon, _getFrameworkPatterns, // P9 fix: _getFrameworkCentroids 删除 (死代码)
  _getEmotionDirections, _getPosVectors, _getCooccurSeed, _getCooccurInvIdx, _getCooccurStop,
  _hitNoise, runStep1Extract,
  _getCognitiveBias, _getSensorimotorZh, _getXanewVad,
  // 尾部工具
  SLANG_HYPERBOLE_WHITELIST, hasSlangHyperbole, applyNegationScope,
  detectEscalationSignals, extractLatestUserMessage, escapeXml,
  __sdp_dirname,
  _VLEX_ENABLED, _MAX_ACT_TERM_FREQ_USERS,
  // setter 函数 (供 diverge 修改模块级缓存)
  _setAxisLexNbCache, _setEnDimCache, _setSentimentZh, _setSentimentEn,
  _setTvSubCatValenceCache, _setOverusedPenaltyCache, _setCnCauseIdx,
  _setTransferVocab, _setEmbodiedCentroidCache, _setStrategyFnCache, _setSwowZhCache,
  // 4个从主控移入的 utils 函数 (a549dade 卡点修复)
  countSetHits, computeSelfEvalAxis, fuseDualChannels, softmax,
  // scoring 函数依赖的词汇常量
  EMO_WORDS_NEG, EMO_WORDS_POS, TECH_WORDS,
  TIME_WORDS_FUTURE, TIME_WORDS_NOW, ACG_WORDS,
  // 向量运算工具(300维专用)
  nbDot300, nbCos300, nbCentroid300,
  // 运行时卸载
  getSelfDrivenP1UtilsCacheStats, clearSelfDrivenP1UtilsCaches,
}
