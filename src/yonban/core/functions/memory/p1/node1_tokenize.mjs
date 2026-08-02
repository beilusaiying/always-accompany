// node1_tokenize.mjs — 分词 + 三层过滤 + 时间保留(自驱动召回新管线 第2节)
//
// 设计来源: P1_新管线设计_算法标注版.md §收集
// 功能链: node0 units →【本模块: 分词(桥)→截断→语言分流→三层过滤→词性白名单→回捞】→ 发散
//
// 白盒铁律: 任何 token 不丢弃,filtered 只打标 {filtered:true, reason},
// 全量 token 流原样返回,谁被谁滤掉、频率/具体性数值多少,全部可读。
//
// 过滤顺序(设计 §过滤): 停用词 → BCC超高频 → 具体性 → 词性白名单;OOV 一律保留。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStopwordsCN, bccFreq, loadMeldSch, loadBrysbaert, loadCoreNatureDict, resourceReport } from './resources.mjs';
import { loadEcdictFrq } from './resources2.mjs';
import { truncateTokens, PARAMS as P0 } from './node0_recall.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
import { httpCall } from './cluster.mjs';

const clampF = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const envF = (name, dflt) => {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
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
  EN_FREQ_HIGH: clampF(envF('P1_EN_FREQ_HIGH', 50000), 1000, 500000),
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
// 英文停用词: 暂用内置最小集,Stanza+NLTK 交集接入后替换(provider 如实上报)
const EN_STOP = new Set(('a,an,the,and,or,but,if,then,than,that,this,these,those,i,you,he,she,it,we,they,'
  + 'is,are,was,were,be,been,being,am,do,does,did,have,has,had,will,would,can,could,should,shall,may,might,'
  + 'to,of,in,on,at,by,for,with,from,as,about,into,over,after,before,not,no,yes,so,too,very,just,also,there,here,'
  + 'what,when,where,who,whom,which,why,how,all,any,some,my,your,his,her,its,our,their,me,him,us,them').split(','));

// ---- 时间提取(设计 §特殊保留): 不进发散,透传 metadata ----
const TIME_RES = [
  /(\d{2,4})[年.\-\/](\d{1,2})[月.\-\/](\d{1,2})[日号]?/g,
  /(\d{2,4})年(\d{1,2})月?|(\d{1,2})月(\d{1,2})[日号]/g,
  /(\d{1,2})月|(\d{1,2})[日号]/g,           // 单独"N月/N日"也是有具体数据的时间(设计: 年,月,日有具体数据的)
  /(今天|昨天|前天|明天|后天|上周|下周|上个月|下个月|去年|明年)/g,
  /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g,
  /\b(today|yesterday|tomorrow|last\s+week|next\s+week|last\s+month)\b/gi,
  /\b(19|20)\d{2}\b/g,
];
// normalized(设计 {raw, normalized, position}): 绝对日期→YYYY-MM-DD;年月→YYYY-MM;相对词→rel:原词(离线无"今天"基准,消费方结合会话时间解析)
function normalizeTime(raw) {
  let m = raw.match(/(\d{2,4})[年.\-\/](\d{1,2})[月.\-\/](\d{1,2})[日号]?/) || raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const [a, b, c] = [m[1], m[2], m[3]].map(Number);
    const [y, mo, d] = a > 31 ? [a, b, c] : [c, a, b];
    return `${y < 100 ? 2000 + y : y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  m = raw.match(/(\d{2,4})年(\d{1,2})月?/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  if (/^(19|20)\d{2}$/.test(raw)) return raw;
  m = raw.match(/^(\d{1,2})月$/);
  if (m) return `--${String(+m[1]).padStart(2, '0')}`;
  m = raw.match(/^(\d{1,2})[日号]$/);
  if (m) return `---${String(+m[1]).padStart(2, '0')}`;
  return `rel:${raw}`;
}

export function extractTimeAnchors(text, unitIdx) {
  const anchors = [];
  const seen = new Set();
  for (const re of TIME_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = `${m.index}:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ raw: m[0], position: m.index, unit: unitIdx, normalized: normalizeTime(m[0]) });
    }
  }
  // 被更长锚完全包含的短锚丢弃(如 "2024年3月" ⊂ "2024年3月15日"),白盒只留最长事实
  const kept = anchors.filter(a => !anchors.some(b =>
    b !== a && b.raw.length > a.raw.length
    && a.position >= b.position && a.position + a.raw.length <= b.position + b.raw.length));
  return kept.sort((a, b) => a.position - b.position);
}

// ---- 分词: 集群 tokenize_service :13151 → 不在时本地字符级降级(管线不崩) ----
let _tokDegraded = false;
export async function bridgeTokenize(texts) {
  if (!_tokDegraded) {
    const r = await httpCall('tokenize', 'tokenize', { texts });
    if (!r._cluster_err && !r.error && r.results) return r;
    _tokDegraded = true;
    console.warn(`[node1] tokenize 集群不可用(${r.error || 'fetch failed'})，降级本地字符分词`);
  }
  return {
    provider: { segmenter: 'fallback:char', pos: 'none', stanza: 'none' },
    results: texts.map(text => {
      const toks = [];
      const EN = /[A-Za-z][A-Za-z0-9._#\-]*/g;
      let cursor = 0, m;
      while ((m = EN.exec(text)) !== null) {
        for (const ch of text.slice(cursor, m.index)) if (ch.trim()) toks.push({ w: ch, pos: 'x', oov: true });
        toks.push({ w: m[0], pos: 'eng', oov: true, enSeg: true });
        cursor = m.index + m[0].length;
      }
      for (const ch of text.slice(cursor)) if (ch.trim()) toks.push({ w: ch, pos: 'x', oov: true });
      return toks;
    }),
  };
}

// ---- 单 token 过滤判定(白盒: 返回完整判定依据) ----
function judgeZh(tok, stopSet, meld, coreDict) {
  const { w, pos, oov } = tok;
  const freq = bccFreq(w);
  const conc = meld.get(w);
  const corePos = coreDict?.get(w) ?? null;
  const base = { bccFreq: freq, conc: conc ?? null, corePos };
  // OOV 豁免只给真词汇(含文字字符): 标点/纯数字不在 jieba 词典≠内容词(白盒0801抓出的误留)
  if (oov && /\p{L}/u.test(w)) return { ...base, filtered: false, keptBy: 'oov' };
  if (stopSet.has(w)) return { ...base, filtered: true, reason: 'stop' };
  if (freq > PARAMS.BCC_SUPERHIGH) return { ...base, filtered: true, reason: 'bcc' };
  if (w.length === 1 && freq > PARAMS.BCC_FRAG_SINGLE) return { ...base, filtered: true, reason: 'frag' };
  if (conc !== undefined && conc < PARAMS.CONC_FLOOR) return { ...base, filtered: true, reason: 'conc' };
  if (!NOUN_POS.has(pos)) {
    if (corePos && NOUN_POS.has(corePos))
      return { ...base, filtered: false, keptBy: 'core_noun_override' };
    return { ...base, filtered: true, reason: 'pos' };
  }
  return { ...base, filtered: false, keptBy: 'noun' };
}

// 英文白名单词性(设计§分词: 保留 NOUN, PROPN, X;过滤 PRON/AUX/DET/ADP/CONJ/SCONJ/PART/INTJ/PUNCT)
const EN_UPOS_KEEP = new Set(['NOUN', 'PROPN', 'X']);
// ECDICT frq 上限挂 PARAMS(config 键 enFreqHigh; 0=标注不过滤)

function judgeEn(word, brys, upos) {
  const lw = word.toLowerCase();
  const conc = brys.get(lw);
  const ec = loadEcdictFrq();
  const frq = ec.available ? (ec.data.get(lw) ?? null) : null;
  const base = { conc: conc ?? null, ecdictFrq: frq };
  if (lw.length < 2) return { ...base, filtered: true, reason: 'frag' }; // 单字母(盘符/缩写残片)=碎词
  if (EN_STOP.has(lw)) return { ...base, filtered: true, reason: 'stop' };
  if (upos && !EN_UPOS_KEEP.has(upos)) return { ...base, filtered: true, reason: 'pos' }; // Stanza 白名单
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
  const coreDict = loadCoreNatureDict();

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
      const aiOutput = u.type === 'ai_output'; // AI输出单元: 不做名词限定(凛倾0801),词性白名单放行
      if (/^[\p{P}\p{S}]+$/u.test(tok.w)) {
        verdict = { filtered: true, reason: 'punct' };  // 标点/符号
      } else if (_isPathFragment(tok.w, rawHasPath)) {
        verdict = { filtered: true, reason: 'path' };
      } else if (unitAnchors.some(a => a.raw.includes(tok.w))) {
        // 时间锚覆盖的 token 不进发散(设计 §特殊保留),事实经 timeAnchors 透传
        verdict = { filtered: true, reason: 'time' };
      } else {
        verdict = isEn ? judgeEn(tok.w, brys, aiOutput ? null : tok.upos) : judgeZh(tok, stopSet, meld, coreDict);
        if (aiOutput && verdict.filtered && verdict.reason === 'pos') {
          verdict = { ...verdict, filtered: false, keptBy: 'ai_output' }; // 名词白名单对AI输出放行(虚词/停用/碎词层照滤)
        }
      }
      contextTokens.push({
        word: tok.w,
        pos: tok.pos,
        ...(tok.upos ? { upos: tok.upos } : {}),
        lang: isEn ? 'en' : 'zh',
        oov: tok.oov,
        unit: ui,
        unitType: u.type,
        position: pos,
        source_sentence_idx: tok.sentIdx ?? null,
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
        && !['punct', 'time', 'path'].includes(t.reason)
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
    provider: bridged.provider,
    resources: resourceReport(),
    params: { ...PARAMS, MAX_WORDS: P0.MAX_WORDS },
  };
}
