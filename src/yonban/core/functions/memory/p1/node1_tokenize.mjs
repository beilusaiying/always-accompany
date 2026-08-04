// node1_tokenize.mjs — 分词 + 三层过滤 + 时间保留(自驱动召回新管线 第2节)
//
// 设计来源: P1_新管线设计_算法标注版.md §收集
// 功能链: node0 units →【本模块: 分词(桥)→截断→语言分流→三层过滤→词性白名单→回捞】→ 发散
//
// 白盒铁律: 任何 token 不丢弃,filtered 只打标 {filtered:true, reason},
// 全量 token 流原样返回,谁被谁滤掉、频率/具体性数值多少,全部可读。
//
// 过滤顺序(设计 §过滤): 停用词 → BCC超高频 → 具体性 → 词性白名单;OOV 一律保留。

import { loadStopwordsCN, bccFreq, loadMeldSch, loadBrysbaert, resourceReport } from './resources.mjs';
import { loadEcdictFrq } from './resources2.mjs';
import { truncateTokens, PARAMS as P0 } from './node0_recall.mjs';

import { httpCall } from './cluster.mjs';

const clampF = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const envF = (name, dflt) => {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
};
const choice = (value, allowed, dflt) => allowed.includes(value) ? value : dflt;
const envInt = (name, dflt) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return dflt;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : dflt;
};

export const PARAMS = {
  // BCC 超高频线: freq>800000 全是功能词(probe_bcc 2026-06-13 实测定档,已定档)
  BCC_SUPERHIGH: 800000,
  // 单字碎词线(设计"碎词"层): 单字且 freq>500K 硬删,不对称于多字词(历史 exp3 定档)
  BCC_FRAG_SINGLE: 500000,
  // 中文具体性下限 [待实验定→白盒定]: 先取设计建议 2.0,拿真实case白盒输出读校
  CONC_FLOOR: clampF(envF('P1_CONC_FLOOR', 2.0), 1.0, 5.0),
  // 英文具体性下限,与中文对齐
  EN_CONC_FLOOR: clampF(envF('P1_EN_CONC_FLOOR', 2.0), 1.0, 5.0),
  // 回捞: 过滤后名词数 < 2 时按 BCC 频率升序回捞补足(设计 §误杀兜底)
  MIN_NOUNS: 2,
  // ECDICT 英文高频词上限 [待实验定]: 参考 ECDICT frq 分布,极高频功能词滤除
  EN_FREQ_HIGH: clampF(envF('P1_EN_FREQ_HIGH', 0), 0, 99999999),
  // 英文 POS 后端：wordnet 复用向量服务的词法库，满足 2GB 预算；stanza 为显式重后端。
  EN_POS_BACKEND: choice(process.env.P1_EN_POS_BACKEND, ['wordnet', 'stanza', 'none'], 'wordnet'),
  // 回捞 BCC 上限: 高于此值的词不回捞(高频功能词被滤是正确行为)
  // 来源: 0730实验定档 BCC_DEMOTE_FREQ=500K(118词探测: 有信息词全<500K)
  RESCUE_BCC_CEIL: clampF(envF('P1_RESCUE_BCC_CEIL', 500000), 100000, 3000000),
};

// 词性白名单(ICTCLAS 标签, jieba/HanLP 同族): 名词类 + 非汉字串;OOV 另行豁免
const NOUN_POS = new Set(['n', 'nr', 'ns', 'nt', 'nz', 'nx', 'ng', 'nrt', 'eng']);

// ---- 路径剥离: tokenize 前把文件路径替换为空, 避免路径碎片进入分词 ----
const PATH_RE = /[A-Z]:\\[\w\-一-鿿\\./]+|\/[\w\-./]{3,}(?:\/[\w\-./]+)+/g;
function stripPaths(text) {
  return text.replace(PATH_RE, ' ');
}

// ---- 路径碎片检测(兜底): 剥离后漏网的路径段 ----
const PATH_NOISE = new Set(['shajiuguan', 'beilu', 'yonban', 'sillytavern', 'accompany', 'plugins', 'shells', 'src', 'public', 'data', 'users', 'chars', 'chats', 'memory', 'core', 'functions', 'parts', 'lib', 'css', 'mjs', 'json', 'txt', 'md', 'tsx', 'jsx', 'vue', 'py', 'ts', 'js']);
function _isPathFragment(word, rawHasPath) {
  if (!rawHasPath) return false;
  if (/[\\\/]/.test(word)) return true;
  if (/^[A-Z]:?$/.test(word)) return true;  // 盘符 D C E
  if (PATH_NOISE.has(word.toLowerCase())) return true;
  return false;
}

// 英文 token 判定(设计 §语言检测)
const EN_RE = /^[a-zA-Z][a-zA-Z0-9_.\-]*$/;
// 英文停用词: 内置稳定集；词性由可配置 WordNet/Stanza 后端另行标注(provider 如实上报)
const EN_STOP = new Set(('a,an,the,and,or,but,if,then,than,that,this,these,those,i,you,he,she,it,we,they,'
  + 'is,are,was,were,be,been,being,am,do,does,did,have,has,had,will,would,can,could,should,shall,may,might,'
  + 'to,of,in,on,at,by,for,with,from,as,about,into,over,after,before,not,no,yes,so,too,very,just,also,there,here,'
  + 'what,when,where,who,whom,which,why,how,all,any,some,my,your,his,her,its,our,their,me,him,us,them').split(','));

// ---- 权威分词/POS 结果 LRU ----
// Node1 输入与 Node2 候选二次词性过滤共用 bridgeTokenize。候选在连续召回中高度重复，
// 但结果只由完整文本、词性后端和集群资源身份决定；按此契约缓存可避免重复 ONNX/WordNet 推理。
// 缓存只接收通过完整服务契约校验的最终结果，不保存失败或半成品。
const TOKENIZE_CACHE_DEFAULT = 4096;
const TOKENIZE_CACHE_HARD_MAX = 16384;
const TOKENIZE_CACHE_MAX = Math.max(0, Math.min(
  TOKENIZE_CACHE_HARD_MAX,
  envInt('P1_TOKENIZE_CACHE_MAX', TOKENIZE_CACHE_DEFAULT),
));
const TOKENIZE_CACHE_SCHEMA = 'p1-token-pos-v1';
const _tokenizeCache = new Map();
let _tokenizeCacheTotals = { hits: 0, misses: 0, evictions: 0 };
let _tokenizeCacheLastCall = { requested: 0, hits: 0, misses: 0, fetched: 0 };

function cloneCacheValue(value) {
  if (Array.isArray(value)) return value.map(cloneCacheValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneCacheValue(item)]));
  }
  return value;
}

function tokenizeBackendIdentity(tokenizerBackend) {
  return JSON.stringify({
    schema: TOKENIZE_CACHE_SCHEMA,
    englishPosBackend: PARAMS.EN_POS_BACKEND,
    tokenizerEnglishBackend: tokenizerBackend,
    tokenizePort: String(process.env.P1_TOK_PORT ?? '13151'),
    vectorPort: String(process.env.P1_VEC_PORT ?? '13152'),
    tokenizerBackend: String(process.env.P1_TOK_BACKEND ?? 'fast'),
    resourceDir: String(process.env.P1_RESOURCE_DIR ?? ''),
    derivedDir: String(process.env.P1V2_DERIVED ?? ''),
    fullUserDictionary: String(process.env.P1_USERDICT_FULL ?? ''),
  });
}

function tokenizeCacheKey(identity, text) {
  return JSON.stringify([identity, text]);
}

function getTokenizeCacheEntry(key) {
  const entry = _tokenizeCache.get(key);
  if (!entry) return null;
  // Map 删除再插入即提升为最近使用项；返回克隆，避免 Node2 添加/修改字段污染缓存。
  _tokenizeCache.delete(key);
  _tokenizeCache.set(key, entry);
  return cloneCacheValue(entry);
}

function setTokenizeCacheEntry(key, entry) {
  if (TOKENIZE_CACHE_MAX <= 0) return;
  if (_tokenizeCache.has(key)) _tokenizeCache.delete(key);
  _tokenizeCache.set(key, cloneCacheValue(entry));
  while (_tokenizeCache.size > TOKENIZE_CACHE_MAX) {
    const oldest = _tokenizeCache.keys().next().value;
    _tokenizeCache.delete(oldest);
    _tokenizeCacheTotals.evictions += 1;
  }
}

export function tokenizeCacheReport() {
  return {
    ..._tokenizeCacheLastCall,
    entries: _tokenizeCache.size,
    max: TOKENIZE_CACHE_MAX,
    hardMax: TOKENIZE_CACHE_HARD_MAX,
    totalHits: _tokenizeCacheTotals.hits,
    totalMisses: _tokenizeCacheTotals.misses,
    evictions: _tokenizeCacheTotals.evictions,
  };
}

export function clearTokenizeCache() {
  const before = tokenizeCacheReport();
  _tokenizeCache.clear();
  _tokenizeCacheTotals = { hits: 0, misses: 0, evictions: 0 };
  _tokenizeCacheLastCall = { requested: 0, hits: 0, misses: 0, fetched: 0 };
  return {
    cleared: before.entries,
    max: TOKENIZE_CACHE_MAX,
    before,
    after: tokenizeCacheReport(),
  };
}

// ---- 时间提取(设计 §特殊保留): 不进发散,透传 metadata ----
const TIME_RES = [
  /(\d{2,4})年(\d{1,2})月(\d{1,2})[日号]?/g,
  /\b(\d{2,4})([.\-\/])(\d{1,2})\2(\d{1,2})\b/g,
  /(\d{2,4})年(\d{1,2})月?|(\d{1,2})月(\d{1,2})[日号]/g,
  /(?<!\d)((?:[1-9]|1[0-2]))月|(?<!\d)((?:[1-9]|[12]\d|3[01]))[日号]/g, // 单独"N月/N日"也是有具体数据的时间
  /(今天|昨天|前天|明天|后天|上周|下周|上个月|下个月|去年|明年)/g,
  // 数字日期要求两个分隔符一致；拒绝版本/范围式 07-23/24。
  /\b(\d{1,2})([\/\-])(\d{1,2})\2(\d{2,4})\b/g,
  /\b(today|yesterday|tomorrow|last\s+week|next\s+week|last\s+month)\b/gi,
  /\b(19|20)\d{2}年/g,
  /\b(19|20)\d{2}\b/g,
];
// normalized(设计 {raw, normalized, position}): 绝对日期→YYYY-MM-DD;年月→YYYY-MM;相对词→rel:原词(离线无"今天"基准,消费方结合会话时间解析)
function normalizeTime(raw) {
  let m = raw.match(/(\d{2,4})年(\d{1,2})月(\d{1,2})[日号]?/);
  let mdy = false;
  if (!m) {
    const ymd = raw.match(/(\d{2,4})([.\-\/])(\d{1,2})\2(\d{1,2})/);
    if (ymd) m = [ymd[0], ymd[1], ymd[3], ymd[4]];
  }
  if (!m) {
    const md = raw.match(/(\d{1,2})([\/\-])(\d{1,2})\2(\d{2,4})/);
    if (md) { m = [md[0], md[1], md[3], md[4]]; mdy = true; }
  }
  if (m) {
    const [a, b, c] = [m[1], m[2], m[3]].map(Number);
    let [y, mo, d] = (!mdy && a > 31) ? [a, b, c] : [c, a, b];
    if (y < 100) y += 2000;
    if (y < 1900 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const valid = new Date(y, mo - 1, d);
    if (valid.getFullYear() !== y || valid.getMonth() !== mo - 1 || valid.getDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  m = raw.match(/^(\d{1,2})月(\d{1,2})[日号]$/);
  if (m) {
    const mo = +m[1], d = +m[2];
    const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (mo < 1 || mo > 12 || d < 1 || d > maxDays[mo - 1]) return null;
    return `--${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  m = raw.match(/(\d{2,4})年(\d{1,2})月?/);
  if (m) {
    const y = +m[1], mo = +m[2];
    if (y < 1900 || y > 2099 || mo < 1 || mo > 12) return null;
    return `${m[1]}-${String(mo).padStart(2, '0')}`;
  }
  if (/^(19|20)\d{2}年$/.test(raw)) return raw.slice(0, 4);
  if (/^(19|20)\d{2}$/.test(raw)) return raw;
  m = raw.match(/^(\d{1,2})月$/);
  if (m) {
    const mo = +m[1];
    return mo >= 1 && mo <= 12 ? `--${String(mo).padStart(2, '0')}` : null;
  }
  m = raw.match(/^(\d{1,2})[日号]$/);
  if (m) {
    const d = +m[1];
    return d >= 1 && d <= 31 ? `---${String(d).padStart(2, '0')}` : null;
  }
  return `rel:${raw}`;
}

export function extractTimeAnchors(text, unitIdx) {
  const anchors = [];
  const seen = new Set();
  for (const re of TIME_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const normalized = normalizeTime(m[0]);
      if (!normalized) continue;
      const key = `${m.index}:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ raw: m[0], position: m.index, unit: unitIdx, normalized });
    }
  }
  // 被更长锚完全包含的短锚丢弃(如 "2024年3月" ⊂ "2024年3月15日"),白盒只留最长事实
  const kept = anchors.filter(a => !anchors.some(b =>
    b !== a && b.raw.length > a.raw.length
    && a.position >= b.position && a.position + a.raw.length <= b.position + b.raw.length));
  return kept.sort((a, b) => a.position - b.position);
}

// ---- 分词: 集群 tokenize_service :13151；断链必须进入上层 failure envelope ----
async function fetchAuthoritativeTokenize(texts, tokenizerBackend) {
  const r = await httpCall('tokenize', 'tokenize', { texts, englishPosBackend: tokenizerBackend });
  if (r?._cluster_err || r?.success !== true || r?.error) {
    const error = new Error(`tokenize cluster failed: ${r?.error ?? 'invalid tokenize response'}`);
    error.code = r?.code ?? 'P1_TOKENIZE_CLUSTER_ERROR';
    error.details = {
      ...(r?.details && typeof r.details === 'object' ? r.details : {}),
      service: 'tokenize',
      status: r?.status ?? null,
      provider: r?.provider ?? r?.body?.provider ?? null,
      upstream: r?.body ?? r ?? null,
    };
    throw error;
  }
  const onnxReady = r?.provider?.posStatus?.available === true
    && r.provider.posStatus.backend === 'onnx_ctb9'
    && typeof r.provider.posStatus.label === 'string'
    && r.provider.posStatus.label.startsWith('onnx_ctb9_');
  if (!Array.isArray(r?.results) || !onnxReady
    || r.results.length !== texts.length || r.results.some(tokens => !Array.isArray(tokens))) {
    const actual = Array.isArray(r?.results) ? r.results.length : null;
    const error = new Error(`tokenize cluster contract mismatch: expected ${texts.length} result sets with available ONNX POS, got ${actual ?? 'invalid'}`);
    error.code = 'P1_TOKENIZE_CLUSTER_CONTRACT_ERROR';
    error.details = {
      service: 'tokenize', expected: texts.length, actual,
      onnxReady, provider: r?.provider ?? null,
    };
    throw error;
  }
  r.provider ??= {};
  if (PARAMS.EN_POS_BACKEND === 'wordnet') {
    const words = [...new Set(r.results.flatMap(tokens => tokens
      .map(token => token.w)
      .filter(word => EN_RE.test(word))))];
    const pos = words.length
      ? await httpCall('vector', 'wn_pos', { words })
      : { available: true, results: {}, provider: 'wordnet_first_synset', oovCount: 0 };
    if (words.length && (pos?._cluster_err || pos?.available !== true || !pos?.results || typeof pos.results !== 'object')) {
      const error = new Error(`WordNet POS backend failed: ${pos?.why ?? pos?.error ?? 'invalid wn_pos response'}`);
      error.code = pos?.code ?? 'P1_WORDNET_POS_UNAVAILABLE';
      error.details = {
        ...(pos?.details && typeof pos.details === 'object' ? pos.details : {}),
        service: 'vector',
        backend: 'wordnet',
        status: pos?.status ?? null,
        words,
        upstream: pos?.body ?? pos ?? null,
      };
      throw error;
    }
    for (const tokens of r.results) {
      for (const token of tokens) {
        if (pos.results?.[token.w]) token.upos = pos.results[token.w];
      }
    }
    r.provider.englishPos = {
      backend: 'wordnet', available: pos.available === true,
      provider: pos.provider ?? null, oovCount: pos.oovCount ?? null,
      why: pos.available === true ? null : (pos.why ?? pos.error ?? 'wordnet unavailable'),
    };
  } else {
    const stanzaAvailable = r.provider.stanza === 'stanza_en' || r.provider.stanza === 'none_needed';
    r.provider.englishPos = {
      backend: PARAMS.EN_POS_BACKEND,
      available: PARAMS.EN_POS_BACKEND === 'stanza' ? stanzaAvailable : true,
      provider: PARAMS.EN_POS_BACKEND === 'stanza' ? r.provider.stanza : 'none',
    };
  }
  return r;
}

export async function bridgeTokenize(texts) {
  const tokenizerBackend = PARAMS.EN_POS_BACKEND === 'stanza' ? 'stanza' : 'none';
  const identity = tokenizeBackendIdentity(tokenizerBackend);
  const results = new Array(texts.length);
  const missingByKey = new Map();
  let cachedProvider = null;
  let hits = 0;
  let misses = 0;

  texts.forEach((text, index) => {
    const key = tokenizeCacheKey(identity, text);
    const cached = getTokenizeCacheEntry(key);
    if (cached) {
      results[index] = cached.tokens;
      cachedProvider ??= cached.provider;
      hits += 1;
      return;
    }
    misses += 1;
    let missing = missingByKey.get(key);
    if (!missing) {
      missing = { key, text, indexes: [] };
      missingByKey.set(key, missing);
    }
    missing.indexes.push(index);
  });

  const missing = [...missingByKey.values()];
  let provider = cachedProvider ?? {};
  if (missing.length || texts.length === 0) {
    // 只发送缺失的唯一完整文本；此调用及后续 WordNet POS 任一失败都会直接抛出，
    // 并且在全部结果完成校验前不会写入缓存。
    const fetched = await fetchAuthoritativeTokenize(missing.map(item => item.text), tokenizerBackend);
    provider = cloneCacheValue(fetched.provider ?? {});
    const prepared = missing.map((item, index) => ({
      ...item,
      tokens: cloneCacheValue(fetched.results[index]),
      provider: cloneCacheValue(fetched.provider ?? {}),
    }));
    for (const item of prepared) {
      setTokenizeCacheEntry(item.key, { tokens: item.tokens, provider: item.provider });
      for (const index of item.indexes) results[index] = cloneCacheValue(item.tokens);
    }
  }

  _tokenizeCacheTotals.hits += hits;
  _tokenizeCacheTotals.misses += misses;
  _tokenizeCacheLastCall = {
    requested: texts.length,
    hits,
    misses,
    fetched: missing.length,
  };
  const cache = tokenizeCacheReport();
  return {
    success: true,
    results: results.map(cloneCacheValue),
    provider: { ...cloneCacheValue(provider), tokenizeCache: cache },
  };
}

// ---- 单 token 过滤判定(白盒: 返回完整判定依据) ----
function judgeZh(tok, stopSet, meld) {
  const { w, pos, oov } = tok;
  const freq = bccFreq(w);
  const conc = meld.get(w);
  const base = { bccFreq: freq, conc: conc ?? null };
  // OOV 豁免只给真词汇(含文字字符): 标点/纯数字不在 jieba 词典≠内容词(白盒0801抓出的误留)
  if (oov && /\p{L}/u.test(w)) return { ...base, filtered: false, keptBy: 'oov' };
  if (stopSet.has(w)) return { ...base, filtered: true, reason: 'stop' };
  if (freq > PARAMS.BCC_SUPERHIGH) return { ...base, filtered: true, reason: 'bcc' };
  if (w.length === 1 && freq > PARAMS.BCC_FRAG_SINGLE) return { ...base, filtered: true, reason: 'frag' };
  if (conc !== undefined && conc < PARAMS.CONC_FLOOR) return { ...base, filtered: true, reason: 'conc' };
  if (!NOUN_POS.has(pos)) return { ...base, filtered: true, reason: 'pos' };
  return { ...base, filtered: false, keptBy: 'noun' };
}

// 英文白名单词性(设计§分词: 保留 NOUN, PROPN, X;过滤 PRON/AUX/DET/ADP/CONJ/SCONJ/PART/INTJ/PUNCT)
const EN_UPOS_KEEP = new Set(['NOUN', 'PROPN', 'X']);
// ECDICT frq 上限挂 PARAMS(config 键 enFreqHigh; 0=标注不过滤)

function judgeEn(word, brys, upos, ecdict) {
  const lw = word.toLowerCase();
  const conc = brys.get(lw);
  const frq = ecdict.enabled ? (ecdict.data.get(lw) ?? null) : null;
  const base = { conc: conc ?? null, ecdictFrq: frq };
  if (lw.length < 2) return { ...base, filtered: true, reason: 'frag' }; // 单字母(盘符/缩写残片)=碎词
  if (EN_STOP.has(lw)) return { ...base, filtered: true, reason: 'stop' };
  if (upos && !EN_UPOS_KEEP.has(upos)) return { ...base, filtered: true, reason: 'pos' }; // 英文 POS 后端白名单
  if (conc !== undefined && conc < PARAMS.EN_CONC_FLOOR) return { ...base, filtered: true, reason: 'conc' };
  if (PARAMS.EN_FREQ_HIGH > 0 && frq !== null && frq > PARAMS.EN_FREQ_HIGH) return { ...base, filtered: true, reason: 'frq' };
  return { ...base, filtered: false, keptBy: upos ? `en_${upos.toLowerCase()}` : 'en_pass' };
}

// ---- 主入口: node0 输出 → 全量 token 流 ----
// 出口形状(下游 node2 diverge / pipeline 锚词选取消费):
//   contextTokens: 全量打标 token 流(filtered=false 为有效词;pipeline 按 bccFreq 升序选锚词)
//   timeAnchors: 时间事实透传(不进发散,消费方=p1_pipeline 出口);truncation: 截断记录(白盒)
export async function tokenizeUnits(node0Result) {
  const stopSet = loadStopwordsCN();
  const meld = loadMeldSch();
  const brys = loadBrysbaert();
  let ecdict;
  if (PARAMS.EN_FREQ_HIGH <= 0) {
    ecdict = {
      enabled: false, available: null, status: 'disabled', threshold: 0,
      entries: 0, why: 'enFreqHigh=0', data: null,
    };
  } else {
    const loaded = loadEcdictFrq();
    ecdict = {
      enabled: true,
      available: loaded.available === true,
      status: loaded.available === true ? 'enabled' : 'unavailable',
      threshold: PARAMS.EN_FREQ_HIGH,
      entries: loaded.available === true ? loaded.data.size : 0,
      why: loaded.available === true ? null : (loaded.why ?? 'ECDICT unavailable'),
      data: loaded.available === true ? loaded.data : null,
    };
    if (!ecdict.available) {
      const error = new Error(`ECDICT required by enFreqHigh=${PARAMS.EN_FREQ_HIGH}, but unavailable: ${ecdict.why}`);
      error.code = 'P1_ECDICT_UNAVAILABLE';
      error.details = { ecdict: { ...ecdict, data: undefined } };
      throw error;
    }
  }

  const units = node0Result.units;
  // 批量送桥: 收集所有非排除单元的句子(路径剥离后再分词)
  const jobs = [];
  units.forEach((u, ui) => {
    if (u.excluded) return;
    u.sentences.forEach((s, si) => jobs.push({ ui, si, text: stripPaths(s) }));
  });
  const bridged = await bridgeTokenize(jobs.map(j => j.text));

  // 组装 per-unit token 流
  const perUnit = units.map(() => []);
  jobs.forEach((job, k) => {
    for (const t of bridged.results[k]) {
      perUnit[job.ui].push({ ...t, sentIdx: job.si });
    }
  });

  const contextTokens = [];
  const timeAnchors = [];
  const truncation = [];
  units.forEach((u, ui) => {
    if (u.excluded) return;
    const unitAnchors = extractTimeAnchors(u.raw, ui);
    timeAnchors.push(...unitAnchors);
    // 截断: 分词后按词数,每条消息独立(设计 §召回·截断)
    const tr = truncateTokens(perUnit[ui], P0.MAX_WORDS);
    if (tr.truncated) truncation.push({ unit: ui, dropped: tr.dropped });
    const rawHasPath = /[\\\/][a-zA-Z一-鿿]/.test(u.raw);
    tr.tokens.forEach((tok, pos) => {
      const isEn = EN_RE.test(tok.w);
      let verdict;
      if (/^[\p{P}\p{S}]+$/u.test(tok.w)) {
        verdict = { filtered: true, reason: 'punct' };  // 标点/符号
      } else if (_isPathFragment(tok.w, rawHasPath)) {
        verdict = { filtered: true, reason: 'path' };
      } else if (unitAnchors.some(a => a.raw.includes(tok.w))) {
        // 时间锚覆盖的 token 不进发散(设计 §特殊保留),事实经 timeAnchors 透传
        verdict = { filtered: true, reason: 'time' };
      } else {
        verdict = isEn ? judgeEn(tok.w, brys, tok.upos, ecdict) : judgeZh(tok, stopSet, meld);
      }
      contextTokens.push({
        word: tok.w,
        pos: tok.pos,
        segmenterPos: tok.segmenterPos ?? null,
        modelPos: tok.modelPos ?? null,
        modelTag: tok.modelTag ?? null,
        corePos: tok.corePos ?? null,
        posSource: tok.posSource ?? 'unknown',
        ...(tok.upos ? { upos: tok.upos } : {}),
        lang: isEn ? 'en' : 'zh',
        oov: tok.oov,
        unit: ui,
        unitType: u.type,
        position: pos,
        source_sentence_idx: tok.sentIdx ?? null,
        ...(isEn ? {
          ecdictEnabled: ecdict.enabled,
          ecdictAvailable: ecdict.available,
          ecdictStatus: ecdict.status,
        } : {}),
        ...verdict,
      });
    });
  });

  // 回捞(设计 §误杀兜底): 有效名词<MIN_NOUNS → filtered 池按 BCC 频率升序捞回
  // 约束: BCC > SUPERHIGH 的词不回捞(设计"3个加起来基本上可以完美过滤,只留下名词"——
  // 高频功能词被滤是正确行为,rescue 不该推翻。全滤光=输入无内容词,发散拿 0 输入,只做原文直接匹配)
  const kept = () => contextTokens.filter(t => !t.filtered);
  if (kept().length < PARAMS.MIN_NOUNS) {
    const pool = contextTokens
      .filter(t => t.filtered && t.lang === 'zh'
        && t.reason === 'conc'
        && (t.bccFreq ?? 0) < PARAMS.RESCUE_BCC_CEIL)
      .sort((a, b) => (a.bccFreq ?? 0) - (b.bccFreq ?? 0));
    for (const t of pool) {
      if (kept().length >= PARAMS.MIN_NOUNS) break;
      t.filtered = false;
      t.keptBy = 'rescue';
    }
  }

  return {
    contextTokens,
    timeAnchors,
    truncation,
    provider: { ...bridged.provider, ecdict: { ...ecdict, data: undefined } },
    resources: {
      ...resourceReport(),
      coreNatureDict: bridged.provider?.coreNature ?? { available: false, why: 'tokenize provider omitted CoreNature state' },
      ecdict: { ...ecdict, data: undefined },
    },
    params: { ...PARAMS, MAX_WORDS: P0.MAX_WORDS },
  };
}
