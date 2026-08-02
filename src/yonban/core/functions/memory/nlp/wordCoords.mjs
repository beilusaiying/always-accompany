// wordCoords.mjs — 多维词坐标模块（词性/具体度/VAD/领域/cogmech 等多库混合查询）
//
// 功能链：p1_axis / p1_node3 / p1_node6 / p1_node9 → loadWordCoords() + locateCogMechanism / getVAD / getConcreteness / swowDiverge → 坐标值
// why：P1 多维定位需要同一个词在不同维度有坐标（词性/具体抽象度/情感 VAD/领域/认知机制）；
//      多库混合取最优，单库覆盖不到的词由其他库兜底，避免 OOV 崩溃。
// 关联链：
//   ← p1_axis.mjs（scoreWord 8来源之一：locateCogMechanism/getVAD/getConcreteness）
//   ← p1_node3_axis6.mjs / p1_node6_spaceVote.mjs / p1_node9_dirword.mjs（c1TransformA47/c1Norm）
//   ← p1_node2_swow.mjs / queryExpand.mjs（swowDiverge SWOW 发散）
// 影响范围：只读 P1资源库 多个文件（_posMap/_concMap/_vadMap 等 10+ 资源 Map，进程级懒加载）
// 凛倾: "多个库混合,找最优,参考llm的向量坐标"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getResDir } from "../p1/p1_resdir.mjs";  // P0-2 统一资源定位(env P1_RESOURCE_DIR > memory/p1_res > 旧运行位)
const RES_DIR = getResDir();

let _posMap = null;
let _concMap = null;
let _vadMap = null;
let _domainMap = null;
let _glasgowMap = null;
let _cogmechMap = null;
let _cogmechModesMap = null;
let _nrcEmoMap = null;
let _cfnFrameMap = null;
let _ssddMap = null;
let _lancasterMap = null;
let _atomicMap = null;
let _loaded = false;

const POS_NOISE = new Set(["nr","ns","nz","nrt","nrfg","nsf","nt","m","q","r","p","c","u","e","y","o","x"]);
const POS_GOOD = new Set(["n","v","a","vn","an","ad","vd","ng","nf","ag"]);

function _cacheBucketSize(value) {
  if (value == null) return 0;
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  return 0;
}

export function getWordCoordsCacheStats() {
  const caches = {
    pos: _posMap, concreteness: _concMap, vad: _vadMap, domain: _domainMap,
    glasgow: _glasgowMap, cogmech: _cogmechMap, cogmechModes: _cogmechModesMap,
    nrcEmotion: _nrcEmoMap, cfnFrame: _cfnFrameMap, ssdd: _ssddMap,
    lancaster: _lancasterMap, atomic: _atomicMap, emotionIndex: _emotionIndex,
    swowZh: _swowZh, swowEn: _swowEn, synonym: _synonymMap,
    dlut: _dlutMap, nrc: _nrcMap, polarity: _polRes,
  };
  return {
    loaded: _loaded,
    loadedCaches: Object.values(caches).filter((value) => value != null).length,
    buckets: Object.values(caches).reduce((sum, value) => sum + _cacheBucketSize(value), 0),
  };
}

export function clearWordCoordsCaches() {
  _posMap = null;
  _concMap = null;
  _vadMap = null;
  _domainMap = null;
  _glasgowMap = null;
  _cogmechMap = null;
  _cogmechModesMap = null;
  _nrcEmoMap = null;
  _cfnFrameMap = null;
  _ssddMap = null;
  _lancasterMap = null;
  _atomicMap = null;
  _emotionIndex = null;
  _swowZh = null;
  _swowEn = null;
  _synonymMap = null;
  _dlutMap = null;
  _nrcMap = null;
  _polRes = null;
  _loaded = false;
}

export function loadWordCoords() {
  if (_loaded) return;
  _loaded = true;
  _loadPOS();
  _loadConcreteness();
  _loadVAD();
  _loadGlasgow();
  _loadCogmech();
  _loadNrcEmo();
  _loadCfnLex();
  _loadSsdd();
  _loadLancaster();
  _loadAtomic();
}

function _loadPOS() {
  _posMap = new Map();
  const f = path.join(RES_DIR, "jieba_dict.txt");
  if (!fs.existsSync(f)) { console.warn("[wordCoords] jieba_dict.txt not found"); return; }
  const text = fs.readFileSync(f, "utf-8");
  for (const line of text.split("\n")) {
    const parts = line.trim().split(" ");
    if (parts.length >= 3) _posMap.set(parts[0], parts[2]);
  }
  console.log(`[wordCoords] POS loaded: ${_posMap.size}`);
}

function _loadConcreteness() {
  _concMap = new Map();
  // 中文具体度(最高优先级，实测 87942 词；文件名 _78k 为历史命名，实际词数以 json 为准)
  const zh78k = path.join(__dirname, "..", "concreteness_78k.json");
  if (fs.existsSync(zh78k)) {
    try {
      const data = JSON.parse(fs.readFileSync(zh78k, "utf-8"));
      for (const [w, v] of Object.entries(data)) _concMap.set(w, v);
    } catch {}
  }
  // 中文Gemini标注(补充)
  const zhFile = path.join(__dirname, "..", "concreteness_zh.json");
  if (fs.existsSync(zhFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(zhFile, "utf-8"));
      for (const [w, v] of Object.entries(data)) { if (!_concMap.has(w)) _concMap.set(w, v); }
    } catch {}
  }
  // 英文Brysbaert
  const enFile = path.join(RES_DIR, "brysbaert_concreteness.txt");
  if (fs.existsSync(enFile)) {
    const lines = fs.readFileSync(enFile, "utf-8").split("\n");
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split("\t");
      if (parts.length >= 3) {
        const w = parts[0].toLowerCase().trim();
        const c = parseFloat(parts[2]);
        if (w && !isNaN(c) && !_concMap.has(w)) _concMap.set(w, c);
      }
    }
  }
  console.log(`[wordCoords] concreteness loaded: ${_concMap.size} (78k-zh+gemini+brysbaert-en)`);
}

function _loadVAD() {
  _vadMap = new Map();
  // NRC-VAD (0-1 scale, 20K words)
  const f = path.join(RES_DIR, "nrc_vad_lexicon.txt");
  if (fs.existsSync(f)) {
    const lines = fs.readFileSync(f, "utf-8").split("\n");
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split("\t");
      if (parts.length >= 4) {
        const w = parts[0].toLowerCase().trim();
        const v = parseFloat(parts[1]), a = parseFloat(parts[2]), d = parseFloat(parts[3]);
        if (w && !isNaN(v)) _vadMap.set(w, [v, a, d]);
      }
    }
  }
  // 中文affective-11310 (1-7 scale, 25K词) → 归一化到0-1
  const zhAffFile = path.join(__dirname, "..", "affective_zh_11k.json");
  if (fs.existsSync(zhAffFile)) {
    try {
      let added = 0;
      const data = JSON.parse(fs.readFileSync(zhAffFile, "utf-8"));
      for (const [w, entry] of Object.entries(data)) {
        if (_vadMap.has(w)) continue;
        const v = entry.v !== undefined ? (entry.v - 1) / 6 : 0.5;
        const a = entry.a !== undefined ? (entry.a - 1) / 6 : 0.5;
        const d = 0.5;
        _vadMap.set(w, [v, a, d]);
        added++;
      }
      if (added > 0) console.log(`[wordCoords] Chinese affective VAD added: ${added} words`);
    } catch {}
  }
  // Warriner VAD (1-9 scale, 13.9K words) → 归一化到0-1
  const wf = path.join(RES_DIR, "warriner_vad_13k.csv");
  if (fs.existsSync(wf)) {
    let added = 0;
    const lines = fs.readFileSync(wf, "utf-8").split("\n");
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 10) continue;
      const w = parts[1]?.toLowerCase().trim();
      if (!w || _vadMap.has(w)) continue;
      const v = (parseFloat(parts[2]) - 1) / 8;
      const a = (parseFloat(parts[5]) - 1) / 8;
      const d = (parseFloat(parts[8]) - 1) / 8;
      if (!isNaN(v)) { _vadMap.set(w, [v, a, d]); added++; }
    }
    if (added > 0) console.log(`[wordCoords] Warriner VAD added: ${added} new words`);
  }
  // NRC-VAD v2.1 (55K词, 2025版, -1~+1 scale) → 归一化到0-1
  const v2File = path.join(__dirname, "..", "nrc_vad_v2.json");
  if (fs.existsSync(v2File)) {
    try {
      let added = 0;
      const v2 = JSON.parse(fs.readFileSync(v2File, "utf-8"));
      for (const [w, entry] of Object.entries(v2)) {
        if (_vadMap.has(w)) continue;
        const v = (entry.v + 1) / 2;
        const a = (entry.a + 1) / 2;
        const d = (entry.d + 1) / 2;
        _vadMap.set(w, [v, a, d]);
        added++;
      }
      if (added > 0) console.log(`[wordCoords] NRC-VAD v2.1 added: ${added} words`);
    } catch {}
  }
  // EmoBank EN VAD (句子级统计→词级平均, 3807词, 1-5 scale)
  const ebFile = path.join(__dirname, "..", "emobank_en_vad.json");
  if (fs.existsSync(ebFile)) {
    try {
      let added = 0;
      const eb = JSON.parse(fs.readFileSync(ebFile, "utf-8"));
      for (const [w, entry] of Object.entries(eb)) {
        if (_vadMap.has(w)) continue;
        const v = (entry.v - 1) / 4;
        const a = (entry.a - 1) / 4;
        const d = 0.5;
        _vadMap.set(w, [v, a, d]);
        added++;
      }
      if (added > 0) console.log(`[wordCoords] EmoBank EN VAD added: ${added} words`);
    } catch {}
  }
  console.log(`[wordCoords] VAD loaded: ${_vadMap.size} (NRC + Warriner + v2.1 + EmoBank)`);
  // ZH VAD override: 修正高频中文负面词的VAD标错(2026-04-29 Task #34诊断发现)
  // 根因: 中文VAD是"想"+"家"组合时,"家"正面+"想"中性 → 合成正面(0.66), 但"想家"实际是负面情绪
  // 修复: 用人工verified的VAD覆盖错误标注 + 补充NULL词
  // 凛倾原则"不要凭空生成词": 这些是已有词的标注修正,不是新增词
  const ZH_VAD_OVERRIDE = {
    "想家": [0.20, 0.45, 0.30], "思乡": [0.22, 0.40, 0.30], "想念": [0.30, 0.45, 0.40],
    "一个人": [0.30, 0.30, 0.40], "在外面": [0.40, 0.40, 0.45], "孤独": [0.20, 0.55, 0.35],
    "想见": [0.40, 0.50, 0.40], "格外想": [0.25, 0.50, 0.40],
    "撑着": [0.30, 0.55, 0.40], "撑不住": [0.15, 0.65, 0.30], "扛不住": [0.15, 0.65, 0.30],
    "白费": [0.15, 0.50, 0.30], "没意思": [0.30, 0.30, 0.40], "没劲": [0.30, 0.25, 0.40],
    "丢脸": [0.18, 0.65, 0.25], "委屈": [0.18, 0.55, 0.25], "做不好": [0.22, 0.50, 0.25],
    "不知道": [0.40, 0.45, 0.35], "怎么办": [0.35, 0.55, 0.30],
    "好烦": [0.20, 0.65, 0.35], "好累": [0.25, 0.45, 0.30], "好难": [0.22, 0.55, 0.30],
    "心情好差": [0.18, 0.55, 0.30], "心情差": [0.20, 0.50, 0.35],
    "甩锅": [0.20, 0.60, 0.30], "背锅": [0.18, 0.55, 0.30], "被冤枉": [0.15, 0.65, 0.25],
    "killing": [0.15, 0.85, 0.30], "driving me crazy": [0.18, 0.80, 0.25], "driving": [0.40, 0.60, 0.45],
    "stressed": [0.22, 0.65, 0.30], "exhausted": [0.20, 0.45, 0.25], "frustrated": [0.18, 0.65, 0.25],
    "lonely": [0.20, 0.50, 0.30], "homesick": [0.20, 0.45, 0.30],
    // 分词错误修正(中文BCC bigram切分): "一个人/在外面" 被切成不合理的子串
    "个人": [0.50, 0.30, 0.50], "在外": [0.45, 0.40, 0.45], "外面": [0.50, 0.40, 0.50],
    // 其他高频中性词被误标
    "今天": [0.55, 0.45, 0.50], "明天": [0.55, 0.45, 0.50], "昨天": [0.50, 0.40, 0.50],
  };
  let _ovOk = 0, _ovAdd = 0;
  for (const [w, vad] of Object.entries(ZH_VAD_OVERRIDE)) {
    if (_vadMap.has(w)) _ovOk++; else _ovAdd++;
    _vadMap.set(w, vad);
  }
  console.log(`[wordCoords] ZH VAD override: ${_ovOk} corrected, ${_ovAdd} added`);
}

function _loadGlasgow() {
  _glasgowMap = new Map();
  const f = path.join(RES_DIR, "glasgow_norms_9dim.csv");
  if (!fs.existsSync(f)) { console.warn("[wordCoords] glasgow_norms not found"); return; }
  const lines = fs.readFileSync(f, "utf-8").split("\n");
  for (let i = 2; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 25) continue;
    const w = parts[0]?.toLowerCase().trim();
    if (!w) continue;
    const arou = parseFloat(parts[2]);
    const val = parseFloat(parts[5]);
    const dom = parseFloat(parts[8]);
    const cnc = parseFloat(parts[11]);
    const imag = parseFloat(parts[14]);
    const fam = parseFloat(parts[17]);
    const aoa = parseFloat(parts[20]);
    const size = parseFloat(parts[23]);
    if (w && !isNaN(arou)) {
      _glasgowMap.set(w, { arou, val, dom, cnc, imag, fam, aoa, size });
    }
  }
  console.log(`[wordCoords] Glasgow 9-dim loaded: ${_glasgowMap.size}`);
}

function _loadCogmech() {
  _cogmechMap = new Map();
  _cogmechModesMap = new Map();
  const f = path.join(__dirname, "..", "cogmech_gemini.json");
  if (!fs.existsSync(f)) return;
  try {
    const data = JSON.parse(fs.readFileSync(f, "utf-8"));
    for (const [w, tags] of Object.entries(data)) {
      if (w === "_meta") continue;
      if (Array.isArray(tags) && tags.length > 0) {
        _cogmechMap.set(w, tags);
      } else if (tags && typeof tags === "object" && tags.d) {
        _cogmechMap.set(w, tags.d);
        if (tags.m) _cogmechModesMap.set(w, tags.m);
      } else if (typeof tags === "string" && tags.includes(":")) {
        const parsed = tags.split("|").filter(Boolean);
        if (parsed.length > 0) _cogmechMap.set(w, parsed);
      }
    }
    console.log(`[wordCoords] cogmech_gemini loaded: ${_cogmechMap.size} (modes: ${_cogmechModesMap.size})`);
  } catch {}
}

function _loadNrcEmo() {
  _nrcEmoMap = new Map();
  const f = path.join(RES_DIR, "NRC-multilingual", "extracted", "NRC-Emotion-Lexicon", "OneFilePerLanguage", "Chinese-Simplified-NRC-EmoLex.txt");
  if (!fs.existsSync(f)) { console.warn("[wordCoords] NRC-EmoLex Chinese not found"); return; }
  const lines = fs.readFileSync(f, "utf-8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < 12) continue;
    const zhWord = parts[11]?.trim();
    if (!zhWord) continue;
    const emotions = [];
    const labels = ["anger","anticipation","disgust","fear","joy","negative","positive","sadness","surprise","trust"];
    for (let j = 0; j < 10; j++) {
      if (parts[j + 1] === "1") emotions.push(labels[j]);
    }
    if (emotions.length > 0) _nrcEmoMap.set(zhWord, emotions);
  }
  console.log(`[wordCoords] NRC-EmoLex loaded: ${_nrcEmoMap.size} zh words`);
}

function _loadCfnLex() {
  _cfnFrameMap = new Map();
  const f = path.join(RES_DIR, "CFN-Lex", "CFN_LEX_CN.json");
  if (!fs.existsSync(f)) { console.warn("[wordCoords] CFN-Lex not found"); return; }
  try {
    const data = JSON.parse(fs.readFileSync(f, "utf-8"));
    for (const [frame, words] of Object.entries(data)) {
      if (!Array.isArray(words)) continue;
      for (const w of words) {
        if (!_cfnFrameMap.has(w)) _cfnFrameMap.set(w, []);
        _cfnFrameMap.get(w).push(frame);
      }
    }
    console.log(`[wordCoords] CFN-Lex loaded: ${_cfnFrameMap.size} words, ${Object.keys(data).length} frames`);
  } catch {}
}

export function getNrcEmo(word) {
  if (!_nrcEmoMap) _loadNrcEmo();
  return _nrcEmoMap?.get(word) ?? null;
}

export function getCfnFrames(word) {
  if (!_cfnFrameMap) _loadCfnLex();
  return _cfnFrameMap?.get(word) ?? null;
}

function _loadSsdd() {
  _ssddMap = new Map();
  const f = path.join(RES_DIR, "ssdd_rated_semantic_dimensions.csv");
  if (!fs.existsSync(f)) { console.warn("[wordCoords] SSDD not found"); return; }
  const lines = fs.readFileSync(f, "utf-8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 8) continue;
    const w = parts[0]?.trim();
    if (!w) continue;
    _ssddMap.set(w, {
      vision: parseFloat(parts[1]), motor: parseFloat(parts[2]),
      socialness: parseFloat(parts[3]), emotion: parseFloat(parts[4]),
      time: parseFloat(parts[6]), space: parseFloat(parts[7]),
    });
  }
  console.log(`[wordCoords] SSDD 6-dim loaded: ${_ssddMap.size}`);
}

function _loadLancaster() {
  _lancasterMap = new Map();
  const f = path.join(RES_DIR, "lancaster_sensorimotor_39k.csv");
  if (!fs.existsSync(f)) { console.warn("[wordCoords] Lancaster not found"); return; }
  const lines = fs.readFileSync(f, "utf-8").split("\n");
  const header = lines[0]?.split(",").map(h => h.trim());
  if (!header || header.length < 10) return;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 20) continue;
    const w = parts[0]?.trim().toLowerCase();
    if (!w) continue;
    _lancasterMap.set(w, {
      auditory: parseFloat(parts[1]), gustatory: parseFloat(parts[3]),
      haptic: parseFloat(parts[5]), interoceptive: parseFloat(parts[7]),
      olfactory: parseFloat(parts[9]), visual: parseFloat(parts[11]),
      foot: parseFloat(parts[13]), hand: parseFloat(parts[15]),
      head: parseFloat(parts[17]), mouth: parseFloat(parts[19]),
      torso: parseFloat(parts[21]),
    });
  }
  console.log(`[wordCoords] Lancaster 11-dim loaded: ${_lancasterMap.size}`);
}

export function getSsdd(word) {
  if (!_ssddMap) _loadSsdd();
  return _ssddMap?.get(word) ?? null;
}

export function getLancaster(word) {
  if (!_lancasterMap) _loadLancaster();
  return _lancasterMap?.get(word?.toLowerCase()) ?? null;
}

function _loadAtomic() {
  _atomicMap = new Map();
  const f = path.join(__dirname, "..", "atomic_index.json");
  if (!fs.existsSync(f)) return;
  try {
    const data = JSON.parse(fs.readFileSync(f, "utf-8"));
    for (const [w, entry] of Object.entries(data)) _atomicMap.set(w, entry);
    console.log(`[wordCoords] ATOMIC index loaded: ${_atomicMap.size} words`);
  } catch {}
}

export function getAtomicEvent(word) {
  if (!_atomicMap) _loadAtomic();
  return _atomicMap?.get(word?.toLowerCase()) ?? null;
}

export function getGlasgow(word) {
  if (!_glasgowMap) _loadGlasgow();
  return _glasgowMap?.get(word?.toLowerCase()) ?? null;
}

export function getWordPOS(word) {
  if (!_posMap) _loadPOS();
  return _posMap?.get(word) || null;
}

export function isPosNoise(word) {
  const pos = getWordPOS(word);
  return pos ? POS_NOISE.has(pos) : false;
}

export function getConcreteness(word) {
  if (!_concMap) _loadConcreteness();
  return _concMap?.get(word) ?? null;
}

export function getVAD(word) {
  if (!_vadMap) _loadVAD();
  return _vadMap?.get(word) ?? null;
}

// ════════════════════════════════════════════════════════════════
// C1 去坍缩: axes_47 跨学科维(sem_/sm_)的余弦消费变换
// ════════════════════════════════════════════════════════════════
// 根因(词库回执§二实测): 原始 0-1 sem 维全为正、注入共享正偏置, 在 raw 余弦下反而抬高同学科余弦(0.748→0.769)。
// 解法(回执§三实测扫描): sem_/sm_ 块逐维去中点(归一到0-1的维中性值=0.5)使其零均值可判别, 再加权×W 补偿47学科维主导。
//   W 甜点(异义<0.7 且 近义>0.8): W=2→异义0.682/近义0.838; W=3→异义0.653/近义0.812(最佳)。默认3, 待800case复核。
// 表示法决策(A): 词库存 raw 真值(语义), 框架消费层负责去中点+加权。缺值存 null→此处映射为0(不去中点, 避免注入 -0.5×W 伪向量)。
// 词库未填值时 sem 全缺→全0→变换后与原 raw 47D 等同 = 零回归。
export const C1_SEM_W = 3;
export function c1IsSemKey(k) { return k.startsWith("sem_") || k.startsWith("sm_"); }
// 把原始 axes_47 变换到可判别空间。返回新对象(不污染原 meta), 键齐 keys。
export function c1TransformA47(obj, keys, W = C1_SEM_W) {
  if (!obj) return null;
  const out = {};
  for (const k of keys) {
    const v = obj[k];
    if (c1IsSemKey(k)) out[k] = (v == null) ? 0 : (v - 0.5) * W;
    else out[k] = v || 0;
  }
  return out;
}
export function c1Norm(vec, keys) {
  let n = 0;
  for (const k of keys) n += (vec[k] || 0) ** 2;
  return Math.sqrt(n) || 1;
}

// BLQ Sweet-spot打分: 倒U型, 中间值最优
// Score = d / (1 + α·d²), 最大值在 d* = 1/√α
export function sweetSpot(value, optimal, alpha) {
  const d = Math.abs(value - optimal);
  return d / (1 + alpha * d * d);
}

// BLQ IB-tradeoff: 关联理论成本收益
// 太近=冗余(Effects=0), 太远=噪声(Effort=∞), 中间最优
export function ibTradeoff(distance, alpha = 2.0) {
  return distance / (1 + alpha * distance * distance);
}

// 路径协调度
export function pathHarmony(disciplines, totalSteps) {
  const discCount = new Set(disciplines).size;
  const switches = disciplines.filter((d, i) => i > 0 && d !== disciplines[i - 1]).length;
  const coherence = totalSteps > 1 ? 1 - Math.max(0, switches - discCount) / totalSteps : 1;
  return Math.log(1 + discCount) * coherence;
}

// ====== DLUT情绪轴发散(学科坐标作为发散源) ======
let _emotionIndex = null;
const EMOTION_ADJACENT = {
  PA: ["PE"], PE: ["PA"], NA: ["NB","NI"], NB: ["NA","NH","NJ"], NI: ["NA","NB"],
  NC: ["ND","NJ"], ND: ["NC","NI"], NE: ["NB","NH"], NF: ["NG"], NG: ["NF"],
  NH: ["NB","NE"], NI: ["NA","NB"], NJ: ["NB","NC"], PB: ["PA","PG"], PC: ["PD"],
  PD: ["PC","PE"], PE: ["PA","PD"], PF: ["PG"], PG: ["PB","PF"],
};

function _loadEmotionIndex() {
  if (_emotionIndex) return _emotionIndex;
  _emotionIndex = new Map();
  const f = path.join(RES_DIR, "DLUT-Emotionontology", "\u60C5\u611F\u8BCD\u6C47", "\u60C5\u611F\u8BCD\u6C47.csv");
  if (!fs.existsSync(f)) { console.warn("[wordCoords] DLUT not found"); return _emotionIndex; }
  const text = fs.readFileSync(f, "utf-8");
  const wordToEmo = new Map();
  const emoToWords = new Map();
  for (const line of text.split("\n").slice(1)) {
    const parts = line.split(",").map(s => s.trim());
    if (parts.length < 7 || !parts[0] || !parts[4]) continue;
    const word = parts[0], emo = parts[4], strength = parseInt(parts[5]) || 5;
    wordToEmo.set(word, { emo, strength });
    if (!emoToWords.has(emo)) emoToWords.set(emo, []);
    emoToWords.get(emo).push({ word, strength });
  }
  for (const [emo, words] of emoToWords) words.sort((a, b) => b.strength - a.strength);
  _emotionIndex = { wordToEmo, emoToWords };
  console.log(`[wordCoords] DLUT emotion loaded: ${wordToEmo.size} words, ${emoToWords.size} categories`);
  return _emotionIndex;
}

export function emotionDiverge(anchorWord, topK = 5, adjTopK = 3) {
  const idx = _loadEmotionIndex();
  if (!idx.wordToEmo) return [];
  let entry = idx.wordToEmo.get(anchorWord);
  // 子串匹配: "吵架"→查"吵嘴","累"→查"劳累"
  if (!entry) {
    for (const [w, e] of idx.wordToEmo) {
      if (w.includes(anchorWord) || anchorWord.includes(w)) { entry = e; break; }
    }
  }
  if (!entry) return [];

  const results = [];
  const seen = new Set([anchorWord]);

  const sameEmo = idx.emoToWords.get(entry.emo) || [];
  for (const w of sameEmo) {
    if (seen.has(w.word)) continue;
    seen.add(w.word);
    results.push({ word: w.word, source: "emotion_same", emoClass: entry.emo, strength: w.strength });
    if (results.length >= topK) break;
  }

  const adjClasses = EMOTION_ADJACENT[entry.emo] || [];
  for (const adjEmo of adjClasses) {
    const adjWords = idx.emoToWords.get(adjEmo) || [];
    let added = 0;
    for (const w of adjWords) {
      if (seen.has(w.word)) continue;
      seen.add(w.word);
      results.push({ word: w.word, source: "emotion_adjacent", emoClass: adjEmo, strength: w.strength });
      added++;
      if (added >= adjTopK) break;
    }
  }
  return results;
}

// ====== SWOW联想轴发散(人脑真实联想路径) ======
let _swowZh = null;
let _swowEn = null;
let _synonymMap = null;

function _loadSwow() {
  if (_swowZh) return;
  // 优先zh24_official(ZH24真版带strength+rank), fallback zh_full, 再zh_small
  const zhReal = path.join(__dirname, "..", "swow_zh24_official.json");
  const zhFull = path.join(__dirname, "..", "swow_zh_full.json");
  const zhSmall = path.join(__dirname, "..", "swow_associations.json");
  const enFull = path.join(__dirname, "..", "swow_en_full.json");
  const enSmall = path.join(__dirname, "..", "swow_associations_en.json");
  try {
    const _rawZh = JSON.parse(fs.readFileSync(fs.existsSync(zhReal) ? zhReal : (fs.existsSync(zhFull) ? zhFull : zhSmall), "utf-8"));
    // zh24_official是数组[{cue,responses:[{word,strength}]}], 需转为字典{cue:[{word,strength}]}
    if (Array.isArray(_rawZh) && _rawZh.length > 0 && _rawZh[0]?.cue) {
      _swowZh = {};
      for (const entry of _rawZh) {
        if (entry.cue && entry.responses) _swowZh[entry.cue] = entry.responses;
      }
    } else {
      _swowZh = _rawZh;
    }
  } catch { _swowZh = {}; }
  try { _swowEn = JSON.parse(fs.readFileSync(fs.existsSync(enFull) ? enFull : enSmall, "utf-8")); } catch { _swowEn = {}; }
  console.log(`[wordCoords] SWOW loaded: zh=${Object.keys(_swowZh).length} en=${Object.keys(_swowEn).length}`);
}

export function swowDiverge(anchorWord, topK = 8, opts = null) {
  _loadSwow();
  // 英文词优先查_swowEn (协作请求_SWOW升级 §改动2: en_full已加载12K词)
  // 检测: 纯ASCII字母(含空格/连字符/撇号)视为英文词
  const _isEnWord = /^[a-zA-Z][a-zA-Z\s'\-]*$/.test(anchorWord);
  let assocs;
  if (_isEnWord) {
    // 英文词: 优先查英文SWOW(12K词), 查不到再fallback中文
    assocs = _swowEn[anchorWord.toLowerCase()] || _swowEn[anchorWord] || _swowZh[anchorWord] || [];
  } else {
    // 中文词: 优先查中文SWOW, 查不到再fallback英文
    assocs = _swowZh[anchorWord] || _swowEn[anchorWord?.toLowerCase()] || [];
  }

  // fallback 1+2 关闭: 子串匹配和单字拆分产生字面噪声("转行"→"行"→"不行/行人")

  // fallback 3: 同义词查SWOW
  if (assocs.length === 0) {
    if (!_synonymMap) {
      const synFile = path.join(__dirname, "..", "synonym_index.json");
      try { _synonymMap = JSON.parse(fs.readFileSync(synFile, "utf-8")); } catch { _synonymMap = {}; }
    }
    const syns = _synonymMap[anchorWord];
    if (syns) {
      for (const syn of syns) {
        assocs = _swowZh[syn] || [];
        if (assocs.length > 0) break;
      }
    }
  }

  if (assocs.length === 0) return [];

  // 2025版带strength权重: [{word,strength,rank}] → 按strength降序排
  const _hasStrength = assocs.length > 0 && typeof assocs[0] === "object" && assocs[0].strength !== undefined;
  const _sorted = _hasStrength
    ? [...assocs].sort((a, b) => (b.strength || 0) - (a.strength || 0))
    : assocs;

  const _candidates = _sorted
    .map((a, idx) => {
      const word = typeof a === "string" ? a : (a.word || String(a));
      const rank = (typeof a === "object" && a.rank) ? a.rank : (idx + 1);
      return { word, strength: (typeof a === "object" && a.strength), rank, source: "swow" };
    });

  // distance 门控消费端(2026-07-03 调查B 补断链): 调用方(p1_node2_swow._swowOpts)传
  //   {distance:'on', cosToAnchor} 时, 丢掉与 anchor 余弦过高(≈同义, distance≈1)的联想词——
  //   凛倾红线#6"distance 4-5, 禁 distance=1 同义扩散"的 cos 信号层。
  //   此前 opts 收了从未消费(node2 传参端 2026-06 已建, 消费端断链), 注释虚指":624-636"已一并修正。
  //   阈值走 env(魔法数字铁律); 先滤后 slice, 保证 topK 从合格池取满。
  if (opts && String(opts.distance) === "on" && typeof opts.cosToAnchor === "function") {
    const _maxCos = Number(process.env.P1_N2_SWOW_DISTANCE_MAXCOS || 0.85);
    const _filtered = _candidates.filter((c) => {
      const cos = opts.cosToAnchor(c.word);
      return !(typeof cos === "number" && cos >= _maxCos);
    });
    return _filtered.slice(0, topK);
  }

  return _candidates.slice(0, topK);
}

// ====== 多学科认知机制定位(A定位) ======
// 用所有已下载资源做多维坐标定位

// DLUT情感分类 → 心理学维度
let _dlutMap = null;
function _ensureDlut() {
  if (_dlutMap) return;
  _dlutMap = new Map();
  const f = path.join(RES_DIR, "DLUT-Emotionontology", "\u60C5\u611F\u8BCD\u6C47", "\u60C5\u611F\u8BCD\u6C47.csv");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf-8").split("\n").slice(1)) {
    const parts = line.split(",").map(s => s.trim());
    if (parts.length >= 7 && parts[0] && parts[4]) {
      _dlutMap.set(parts[0], { emo: parts[4], strength: parseInt(parts[5]) || 5, polarity: parseInt(parts[6]) || 0 });
    }
  }
}

// NRC情绪 → 心理学维度(中文版)
let _nrcMap = null;
function _ensureNrc() {
  if (_nrcMap) return;
  _nrcMap = new Map();
  const f = path.join(RES_DIR, "Chinese-Simplified-NRC-EmoLex.txt");
  if (!fs.existsSync(f)) {
    const f2 = path.join(RES_DIR, "nrc_vad_lexicon.txt");
    if (fs.existsSync(f2)) {
      for (const line of fs.readFileSync(f2, "utf-8").split("\n").slice(1)) {
        const p = line.split("\t");
        if (p.length >= 4) _nrcMap.set(p[0].trim(), { v: +p[1], a: +p[2], d: +p[3] });
      }
    }
  }
}

export function locateCogMechanism(word, _depth, mode) {
  if (!word) return "general";

  // camelCase/PascalCase复合词拆分(NullPointerException → Null+Pointer+Exception)
  if (!_depth && /^[a-zA-Z]{4,}$/.test(word) && /[a-z][A-Z]/.test(word)) {
    const parts = word.replace(/([a-z])([A-Z])/g, "$1\0$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2").split("\0");
    if (parts.length >= 2) {
      const merged = [];
      for (const p of parts) {
        const r = locateCogMechanism(p.toLowerCase(), 1, mode);
        if (r && !/^(general|general:unlocated)$/.test(r)) {
          for (const tag of r.split("|")) {
            if (!merged.includes(tag) && !tag.startsWith("general:")) merged.push(tag);
          }
        }
      }
      if (parts.some(p => /^(error|exception|failure|fault|bug|crash|violation)$/i.test(p))) {
        if (!merged.includes("process:error_handling")) merged.push("process:error_handling");
      }
      if (merged.length > 0) return merged.join("|");
    }
  }

  _ensureDlut();
  _ensureNrc();
  if (!_cogmechMap) _loadCogmech();
  if (!_glasgowMap) _loadGlasgow();

  const results = [];

  // 0. Gemini标注优先(最高覆盖率)
  // T-016: mode过滤 — 如果词有mode限制且当前mode不在允许列表,跳过Gemini标注
  const allowedModes = mode && _cogmechModesMap ? _cogmechModesMap.get(word) : null;
  const modeBlocked = allowedModes && !allowedModes.includes(mode);
  const geminiTags = modeBlocked ? null : _cogmechMap?.get(word);
  if (geminiTags) {
    for (const t of geminiTags) results.push(t);
  }

  // 1. 心理学维度(DLUT + NRC-EmoLex 8情绪)
  // 链路追踪修复: 高具体度名词(concreteness>4,如"豆腐")的DLUT emotion标签是物体属性不是情绪信号
  // "豆腐"→emotion:PA(正面)导致心理学路由被激活→输出"死亡意识"。修复:高具体度词的emotion标签加"weak:"前缀降权
  if (!results.some(r => r.startsWith("emotion:"))) {
    const dlut = _dlutMap?.get(word);
    if (dlut) {
      const emoMap = { PA: "joy", PE: "goodness", NA: "anger", NB: "sadness", NI: "fear", NC: "disgust", ND: "surprise", NE: "boredom" };
      const _emoTag = "emotion:" + (emoMap[dlut.emo?.slice(0, 2)] || dlut.emo);
      const _conc = getConcreteness(word);
      if (_conc > 4.0) {
        results.push("weak:" + _emoTag);
      } else {
        results.push(_emoTag);
      }
    } else {
      for (const [w, e] of (_dlutMap || [])) {
        if (w.includes(word) || word.includes(w)) { results.push("emotion:" + e.emo); break; }
      }
    }
    // NRC-EmoLex增强(8种情绪标签)
    if (!results.some(r => r.startsWith("emotion:"))) {
      const nrcEmo = _nrcEmoMap?.get(word);
      if (nrcEmo) {
        for (const e of nrcEmo) {
          if (e !== "positive" && e !== "negative") { results.push("emotion:" + e); break; }
        }
      }
    }
  }

  // 1b. CFN-Lex框架语义(语言学维度增强)
  const cfnFrames = _cfnFrameMap?.get(word);
  if (cfnFrames && cfnFrames.length > 0) {
    const frameToAxis = {
      Emotion_active: "emotion", Emotions_by_stimulus: "emotion", Fear: "emotion",
      Cause_emotion: "emotion", Experiencer_focus: "emotion",
      Body_movement: "embodied", Body_parts: "embodied", Perception_active: "sensory",
      Communication: "narrative", Statement: "narrative", Telling: "narrative",
      Arriving: "temporal", Departing: "temporal", Change_of_leadership: "temporal",
      Causation: "logic", Reason: "logic", Purpose: "logic",
      Buildings: "scene", Locale: "scene", Natural_features: "scene",
    };
    for (const frame of cfnFrames.slice(0, 2)) {
      for (const [key, axis] of Object.entries(frameToAxis)) {
        if (frame.includes(key) && !results.some(r => r.startsWith(axis + ":"))) {
          results.push(axis + ":frame_" + frame.slice(0, 20));
          break;
        }
      }
    }
  }

  // 2. 词性维度(语言学)
  const pos = getWordPOS(word);
  if (pos && !results.some(r => r.startsWith("linguistic:"))) {
    const posToFunc = {
      d: "emphasis", c: "conjunction", p: "relation", u: "structural",
      a: "affective", v: "action", n: "entity", vn: "action-entity",
      ad: "manner", t: "temporal", f: "spatial", s: "spatial",
    };
    if (posToFunc[pos]) results.push("linguistic:" + posToFunc[pos]);
  }

  // 3. 具体度维度(认知科学) — 中文Gemini标注 + Glasgow英文
  if (!results.some(r => r.startsWith("cognitive:"))) {
    const conc = getConcreteness(word);
    if (conc !== null) {
      if (conc >= 4) results.push("cognitive:concrete");
      else if (conc <= 2) results.push("cognitive:abstract");
      else results.push("cognitive:medium");
    }
  }

  // 4. VAD维度 — NRC + Glasgow增强
  if (!results.some(r => r.startsWith("valence:") || r.startsWith("arousal:"))) {
    const vad = getVAD(word);
    if (vad) {
      if (vad[0] > 0.7) results.push("valence:positive");
      else if (vad[0] < 0.3) results.push("valence:negative");
      if (vad[1] > 0.7) results.push("arousal:high");
      else if (vad[1] < 0.3) results.push("arousal:low");
    }
  }

  // 4b. Glasgow多维(英文词增强: imageability/size/arousal)
  const glas = _glasgowMap?.get(word?.toLowerCase());
  if (glas) {
    if (glas.imag > 5.5 && !results.some(r => r.includes("concrete"))) results.push("cognitive:high-imageability");
    if (glas.imag < 2.5 && !results.some(r => r.includes("abstract"))) results.push("cognitive:low-imageability");
    if (glas.arou > 5.5 && !results.some(r => r.includes("arousal"))) results.push("arousal:high");
    if (glas.size > 5.5) results.push("spatial:large");
    else if (glas.size < 2.5) results.push("spatial:small");
  }

  // 4c. SSDD 6维(中文感觉运动: Vision/Motor/Socialness/Emotion/Time/Space)
  const ssdd = _ssddMap?.get(word);
  if (ssdd) {
    if (ssdd.vision > 4.0 && !results.some(r => r.startsWith("sensory:visual"))) results.push("sensory:visual_ssdd");
    if (ssdd.motor > 4.0 && !results.some(r => r.startsWith("embodied:"))) results.push("embodied:motor");
    if (ssdd.socialness > 4.0 && !results.some(r => r.startsWith("narrative:"))) results.push("narrative:social");
    if (ssdd.time > 4.0 && !results.some(r => r.startsWith("temporal:"))) results.push("temporal:time_ssdd");
    if (ssdd.space > 4.0 && !results.some(r => r.startsWith("scene:") || r.startsWith("spatial:"))) results.push("spatial:space_ssdd");
    if (Math.abs(ssdd.emotion) > 2.0 && !results.some(r => r.startsWith("emotion:"))) {
      results.push(ssdd.emotion > 0 ? "emotion:positive_ssdd" : "emotion:negative_ssdd");
    }
  }

  // 4d. Lancaster 11维(英文感觉运动)
  const lanc = _lancasterMap?.get(word?.toLowerCase());
  if (lanc) {
    if (lanc.auditory > 3.0 && !results.some(r => r.includes("auditory"))) results.push("sensory:auditory_lanc");
    if (lanc.gustatory > 3.0 && !results.some(r => r.includes("taste"))) results.push("sensory:taste_lanc");
    if (lanc.haptic > 3.0 && !results.some(r => r.includes("sensation"))) results.push("embodied:haptic");
    if (lanc.olfactory > 3.0 && !results.some(r => r.includes("olfactory"))) results.push("sensory:olfactory_lanc");
    if (lanc.visual > 3.5 && !results.some(r => r.includes("visual"))) results.push("sensory:visual_lanc");
    if (lanc.interoceptive > 2.5) results.push("embodied:interoceptive");
    if (lanc.hand > 3.0 && !results.some(r => r.includes("body"))) results.push("embodied:hand");
    if (lanc.foot > 3.0) results.push("embodied:foot");
    if (lanc.mouth > 3.0) results.push("embodied:mouth");
  }

  // 4e. ATOMIC事件索引(英文叙事/情感)
  const atomic = _atomicMap?.get(word?.toLowerCase());
  if (atomic) {
    if (atomic.react && !results.some(r => r.startsWith("emotion:"))) {
      const negEmo = ["sad","angry","upset","frustrated","depressed","anxious","scared","guilty","ashamed","lonely"];
      const posEmo = ["happy","proud","excited","grateful","loved","relieved","accomplished","satisfied"];
      const firstReact = atomic.react[0]?.toLowerCase();
      if (negEmo.some(e => firstReact?.includes(e))) results.push("emotion:negative_atomic");
      else if (posEmo.some(e => firstReact?.includes(e))) results.push("emotion:positive_atomic");
    }
    if (atomic.effect && !results.some(r => r.startsWith("process:"))) results.push("process:event_consequence");
    if (atomic.want && !results.some(r => r.startsWith("narrative:"))) results.push("narrative:event_intention");
    if (atomic.cause) results.push("logic:causal_atomic");
  }

  // 5. 模式匹配(逻辑学/叙事学/具身) — 正则兜底
  const w = word;
  if (!results.some(r => r.startsWith("logic:"))) {
    if (/因为|所以|导致|如果|否则|因此|于是/.test(w)) results.push("logic:causal");
    if (/但是|然而|可是|不过|虽然|却/.test(w)) results.push("logic:contrast");
    if (/然后|接着|之后|最后|首先|其次/.test(w)) results.push("logic:sequential");
    if (/真的|确实|一定|必须|绝对|肯定/.test(w)) results.push("logic:emphasis");
    if (/也许|可能|大概|或许|似乎/.test(w)) results.push("logic:uncertainty");
  }

  // 5a1. 倦怠/疲劳方向标(2026-06-01): "累/疲惫/倦怠/不想动/没力气"在cogmech中只有
  //   embodied:0.9|emotion:0.8|arousal:0.7 这种【强度数值】, 没有方向 → 下游被psychology轴
  //   的physiology前缀全激活 → physiology:sleep("睡眠卫生/睡眠时相延迟")抢占.
  //   真根因: 标注层丢了"累=倦怠/fatigue"的方向, 跑偏到sleep. 这里补方向标 embodied:fatigue
  //   (真实存在的AT dim, 12词: 乏力/身心俱疲/慢性疲劳/系统性疲劳…), 让倦怠词激活倦怠dim而非睡眠dim.
  //   严守不firing睡眠词(睡/眠/觉/瞌睡/嗜睡)避免污染sleep方向. 凛倾铁律: 改代码逻辑不加词.
  if (!results.some(r => r.startsWith("embodied:fatigue"))) {
    const _isSleepWord = /睡|眠|觉|瞌|嗜睡|入睡|午睡|安眠|催眠/.test(w);
    if (!_isSleepWord && /累|疲惫|疲劳|疲乏|倦怠|困倦|乏力|没力气|没劲|提不起劲|无精打采|精疲力竭|筋疲力尽|身心俱疲|耗竭|不想动|懒得动|动不了|没精神|没动力|提不起精神|心力交瘁|过劳|劳累|burnout|exhaust|fatigue/.test(w)) {
      results.push("embodied:fatigue");
    }
  }

  if (!results.some(r => r.startsWith("embodied:"))) {
    if (/肩|腿|胸|头|手|脚|背|腰|眼|胃|心|呼吸|喘|血|骨|皮肤|嘴|耳|鼻|指|腕|踝|膝|颈|肘|腹/.test(w)) results.push("embodied:body");
    if (/冷|热|痛|重|轻|沉|软|硬|滑|粗|刺|麻|紧|松|烫|凉|酥|僵/.test(w)) results.push("embodied:sensation");
  }

  if (!results.some(r => r.startsWith("sensory:"))) {
    if (/酸|甜|苦|辣|香|臭|咸|腥|鲜/.test(w)) results.push("sensory:taste");
    if (/暗|亮|黑|白|红|灰|蓝|绿|黄|紫|橙|金|银|透明|闪|光|影/.test(w)) results.push("sensory:visual");
    if (/响|静|吵|安静|嗡|叮|咚|噼|啪|嘶|鸣/.test(w)) results.push("sensory:auditory");
  }

  if (!results.some(r => r.startsWith("scene:"))) {
    if (/雨|雪|风|阳光|夜|月|星|云|雾|霜|露|闪电|雷/.test(w)) results.push("scene:weather");
    if (/教室|操场|街|路|家|房间|窗|门|桥|车|站|院|楼|厅|园|台|港|岸/.test(w)) results.push("scene:place");
  }

  if (!results.some(r => r.startsWith("narrative:"))) {
    if (/表白|错过|相遇|分别|重逢|告别|承诺|秘密|背叛|谎言|坦白|失约/.test(w)) results.push("narrative:event");
  }
  if (!results.some(r => r.startsWith("process:"))) {
    if (/和好|恢复|放下|接受|原谅|面对|逃避|挣扎|妥协|释怀|崩溃|沉沦/.test(w)) results.push("process:resolution");
  }
  if (!results.some(r => r.startsWith("temporal:"))) {
    if (/开始|结束|毕业|出发|离开|到达|过去|未来|曾经|即将/.test(w)) results.push("temporal:transition");
  }

  // 5b. 心理学维度(依恋/防御/人格动力)
  if (!results.some(r => r.startsWith("psychology:"))) {
    if (/依恋|回避|焦虑型|安全型|共情|移情|投射|防御|压抑|否认|合理化|转移|升华|退行|认同/.test(w)) results.push("psychology:defense_mechanism");
    if (/人格|性格|内向|外向|敏感|自恋|讨好|控制欲|完美主义|强迫|偏执/.test(w)) results.push("psychology:personality");
    if (/潜意识|无意识|自我|本我|超我|心理|精神|创伤|应激|焦虑|恐惧|恐慌/.test(w)) results.push("psychology:psychodynamics");
  }

  // 5c. 社会学维度(刻板印象/文化/群体)
  if (!results.some(r => r.startsWith("sociology:"))) {
    if (/刻板|偏见|歧视|标签|定型|印象|阶层|阶级|特权|弱势/.test(w)) results.push("sociology:stereotype");
    if (/内卷|躺平|摆烂|社畜|打工|996|卷|佛系|丧|焦虑|鸡娃|考公/.test(w)) results.push("sociology:social_phenomenon");
    if (/传统|规范|习俗|礼仪|文化|世俗|潮流|圈子|圈层/.test(w)) results.push("sociology:cultural_norm");
  }

  // 5d. 语用学维度(沟通意图/言外之意)
  if (!results.some(r => r.startsWith("pragmatics:"))) {
    if (/吐槽|抱怨|诉苦|发牢骚|发泄|倒苦水|碎碎念/.test(w)) results.push("pragmatics:complaint");
    if (/求助|帮忙|怎么办|救命|咋办|咋整|支招/.test(w)) results.push("pragmatics:help_seeking");
    if (/分享|安利|推荐|种草|炫耀|晒|报喜/.test(w)) results.push("pragmatics:sharing");
    if (/反讽|阴阳|讽刺|内涵|暗示|言外之意|弦外之音/.test(w)) results.push("pragmatics:indirect");
  }

  // 5e. 关系维度(亲密/冲突/角色)
  if (!results.some(r => r.startsWith("relationship:"))) {
    if (/亲密|暧昧|恋爱|感情|喜欢|爱情|心动|暗恋|表白|牵手|拥抱/.test(w)) results.push("relationship:intimacy");
    if (/冷暴力|冷战|吵架|分手|离婚|出轨|劈腿|绿|渣/.test(w)) results.push("relationship:conflict");
    if (/朋友|闺蜜|兄弟|同事|室友|邻居|前任|对象|男友|女友|老公|老婆/.test(w)) results.push("relationship:role");
  }

  // 默认兜底
  if (results.length === 0) {
    if (pos === "a" || pos === "an") results.push("affective:general");
    else if (pos === "v" || pos === "vn") results.push("action:general");
    else if (pos === "n" || pos === "ng") results.push("entity:general");
    else results.push("general:unlocated");
  }

  return results.join("|");
}

// 综合词坐标查询
export function getWordProfile(word) {
  return {
    pos: getWordPOS(word),
    concreteness: getConcreteness(word),
    vad: getVAD(word),
    isPosNoise: isPosNoise(word),
  };
}

// ====== 极性资源加载(polarity_resources.json: VADER/AFINN/OpinionLex/MEL否定词) ======
let _polRes = null;
function _ensurePolarityResources() {
  if (_polRes) return;
  try {
    const f = path.join(__dirname, "..", "polarity_resources.json");
    if (fs.existsSync(f)) _polRes = JSON.parse(fs.readFileSync(f, "utf-8"));
    else _polRes = {};
  } catch { _polRes = {}; }
}

// 术语极性推断 — 全资源信号计数 + sentimentr归一化
// 数据源(总计~90K词):
//   中文: DLUT 27K(polarity字段) + 知网HowNet 9K + NTUSD 11K + 清华褒贬义 10K
//         + 汉语极值表 23K + 否定词典 70词 + cogmech 9K
//   英文: VADER 7.5K + AFINN 2.5K + OpinionLex 6.8K
//   通用: VAD 80K(NRC+affective+Warriner+EmoBank)
// 学术依据:
//   DLUT情感本体(林鸿飞, 大连理工大学): polarity字段 0=中/1=正/2=负
//   否定准前缀(Xie & Yang 2022, CLSW; Ku et al. 2009, EMNLP): 不/非/无/未/反
//   sentimentr(Rinker 2019): (-1)^(2+n)否定翻转 + δ=Σ/√n归一化
//   VADER(Hutto 2014): compound=x/√(x²+α), α=15
//   NRC-VAD(Mohammad 2018 ACL): valence <0.35=neg, >0.65=pos 标准分界
export function inferSubwordPolarity(termName) {
  _ensureDlut();
  _ensurePolarityResources();

  // ── Layer 1: 全词查表 — 多资源级联(命中即返回, 最高效) ──
  // DLUT(27K, 最权威)
  const dlutFull = _dlutMap?.get(termName);
  if (dlutFull && dlutFull.polarity !== 0) {
    return dlutFull.polarity === 2 ? "negative" : "positive";
  }
  // 中文极性词典(知网+NTUSD+清华合并, 26K)
  const zhPol = _polRes?.zh_polarity?.[termName];
  if (zhPol) return zhPol;
  // 汉语极值表(23K, 连续分数, 阈值: <-0.2=neg, >0.2=pos)
  const extScore = _polRes?.zh_extremes?.[termName];
  if (extScore !== undefined) {
    if (extScore < -0.2) return "negative";
    if (extScore > 0.2) return "positive";
  }

  // ── Layer 2: 英文查表(VADER+AFINN+OpinionLex) ──
  if (/[a-zA-Z]{2,}/.test(termName)) {
    const enWords = termName.toLowerCase().split(/[\s_\-]+/).filter(w => w.length >= 2);
    let eNeg = 0, ePos = 0;
    for (const w of enWords) {
      const vs = _polRes?.en_vader?.[w];
      if (vs !== undefined) { if (vs <= -1.0) eNeg++; else if (vs >= 1.0) ePos++; }
      const as = _polRes?.en_afinn?.[w];
      if (as !== undefined) { if (as <= -1) eNeg++; else if (as >= 1) ePos++; }
      const op = _polRes?.en_opinion?.[w];
      if (op === "negative") eNeg++; else if (op === "positive") ePos++;
    }
    if (eNeg > ePos && eNeg >= 1) return "negative";
    if (ePos > eNeg && ePos >= 1) return "positive";
  }

  // ── Layer 3: 子词信号计数 — DLUT polarity + 中文极性词典 + 极值表 + VAD ──
  // 信号权重: DLUT strength/5(均值=5.31,数据驱动) / 中文词典=1.0 / 极值表=连续值 / VAD=1.0
  let negS = 0, posS = 0, hitCount = 0;
  const fc = termName[0];
  for (let len = Math.min(termName.length, 4); len >= 2; len--) {
    for (let i = 0; i <= termName.length - len; i++) {
      const sub = termName.slice(i, i + len);
      // DLUT polarity(27K)
      const dlut = _dlutMap?.get(sub);
      if (dlut && dlut.polarity !== 0) {
        const w = (dlut.strength || 5) / 5;
        if (dlut.polarity === 2) negS += w; else posS += w;
        hitCount++;
      }
      // 中文极性词典(知网+NTUSD+清华, 26K)
      const zp = _polRes?.zh_polarity?.[sub];
      if (zp) { if (zp === "negative") negS++; else posS++; hitCount++; }
      // 极值表(23K, 连续分数→信号: |score|作为权重)
      const ext = _polRes?.zh_extremes?.[sub];
      if (ext !== undefined) {
        if (ext < -0.1) { negS += Math.min(Math.abs(ext), 1.0); hitCount++; }
        else if (ext > 0.1) { posS += Math.min(ext, 1.0); hitCount++; }
      }
      // VAD(80K, NRC标准阈值)
      const vad = getVAD(sub);
      if (vad) {
        const v = Array.isArray(vad) ? vad[0] : (typeof vad === "object" ? vad.valence : vad);
        if (v !== undefined && v < 0.35) { negS++; hitCount++; }
        else if (v !== undefined && v > 0.65) { posS++; hitCount++; }
      }
    }
  }
  // cogmech情绪标签(权重1, 辅助信号)
  const cog = locateCogMechanism(termName, undefined, "chat");
  if (cog) {
    if (/emotion:(N[A-Z]|sadness|anger|fear)/.test(cog)) { negS += 1; hitCount++; }
    else if (/emotion:(P[A-Z]|joy|love|gratitude)/.test(cog)) { posS += 1; hitCount++; }
  }

  // ── Layer 4: 否定处理 — sentimentr (-1)^(2+n) + DLUT前缀验证 ──
  // (a) 否定词典(70词: "否定""非""不""别""甭""未""莫""勿""并不""从未"等)
  let negatorCount = 0;
  const negWords = _polRes?.negation_zh;
  if (negWords) {
    for (const nw of negWords) {
      if (nw.length >= 2 && termName.startsWith(nw)) { negatorCount++; break; }
    }
  }
  // (b) 学术否定准前缀(不/非/无/未/反, Xie & Yang 2022)
  //     DLUT/中文词典/VAD验证: 首2-4字若是独立正面词→不翻转
  if (negatorCount === 0 && "不非无未反".includes(fc) && termName.length >= 2) {
    let prefixIsPositive = false;
    for (let pLen = Math.min(4, termName.length); pLen >= 2; pLen--) {
      const prefix = termName.substring(0, pLen);
      const pDlut = _dlutMap?.get(prefix);
      if (pDlut && pDlut.polarity === 1) { prefixIsPositive = true; break; }
      const pZh = _polRes?.zh_polarity?.[prefix];
      if (pZh === "positive") { prefixIsPositive = true; break; }
      const pVad = getVAD(prefix);
      if (pVad) {
        const pv = Array.isArray(pVad) ? pVad[0] : (typeof pVad === "object" ? pVad.valence : pVad);
        if (pv !== undefined && pv > 0.65) { prefixIsPositive = true; break; }
      }
    }
    if (!prefixIsPositive) negatorCount++;
  }
  // (c) 语义负面前缀(去/低/逆/失/抗) — DLUT/VAD无单字覆盖(实测全MISS)
  if (negatorCount === 0 && "去低逆失抗".includes(fc)) negatorCount++;
  // sentimentr翻转: (-1)^(2+n)
  if (negatorCount % 2 === 1 && (posS > 0 || negS > 0)) {
    const tmp = posS; posS = negS; negS = tmp;
  }

  // ── 判定: sentimentr δ=Σ/√n 归一化 ──
  if (hitCount === 0) return "neutral";
  const delta = (posS - negS) / Math.sqrt(hitCount);
  // VADER标准: compound = x/√(x²+15), 在我们的信号量级下 |δ|>0.5 ≈ 有极性
  if (delta < -0.5) return "negative";
  if (delta > 0.5) return "positive";
  return "neutral";
}
