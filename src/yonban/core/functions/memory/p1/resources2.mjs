// resources2.mjs — 发散/打分/排序层资源加载(懒加载+缓存,承接 resources.mjs 的收集层资源)
//
// 设计来源: P1_新管线设计_算法标注版.md §发散 / §标注打分 / §code / §work
// 白盒: resourceReport2() 上报每份资源的词条数;缺失明确抛错或标 unavailable,不吞
// 重资源(SWOW/ConceptNet/词林)读 resources_derived/ 派生文件,由 bridge/preprocess_resources.py 一次性生成

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEXBASE = 'D:\\shajiuguan\\p1shiyanshi\\09_P1自驱动_专项\\06_资源库_词库\\P1资源库';
// 派生词库收口: env P1V2_DERIVED > 插件资源位 p1_res\p1v2_derived > 旧生成位置(回退)
const _dc = [
  process.env.P1V2_DERIVED,
  join(dirname(fileURLToPath(import.meta.url)), '..', 'p1_res', 'p1v2_derived'),
  'D:\\shajiuguan\\自驱动召回\\resources_derived',
].filter(Boolean);
export const DERIVED = _dc.find(p => existsSync(p)) ?? _dc[_dc.length - 1];

export const PATHS2 = {
  swowZh: join(DERIVED, 'swow_zh.tsv'),
  swowEn: join(DERIVED, 'swow_en.tsv'),
  conceptnetZh: join(DERIVED, 'conceptnet_zh.json'),
  conceptnetEn: join(DERIVED, 'conceptnet_en.json'),
  cilin: join(DERIVED, 'cilin.tsv'),
  nrcDir: join(LEXBASE, 'NRC-multilingual'),
  emobankDir: join(LEXBASE, 'EmoBank'),
  conc78kDir: join(LEXBASE, 'concreteness-78k'),
  ecdict: join(LEXBASE, 'ECDICT', 'ecdict.csv'),
  atomicDir: join(LEXBASE, 'atomic2020'),
  domainWordsDir: join(LEXBASE, 'DomainWordsDict'),
  codeSmellsDir: join(LEXBASE, 'code-smells'),
  businessDir: join(LEXBASE, 'business-wordlists'),
  // code/work 缩写/术语表(GitHub 抓取,落库后接线;缺失=unavailable 不断链)
  abbrCode: join(DERIVED, 'terms', 'abbreviations_in_code.tsv'),        // abbr \t full_en
  computerese: join(DERIVED, 'terms', 'computerese_zh_en.tsv'),         // en \t zh
  seAbbr: join(DERIVED, 'terms', 'software_engineering_abbr.tsv'),      // abbr \t full_en
  aiTerms: join(DERIVED, 'terms', 'ai_terminology_zh_en.tsv'),          // zh \t en
  glossaries: join(DERIVED, 'terms', 'glossaries_definitions.tsv'),     // term \t definition_en
  basicTech: join(DERIVED, 'terms', 'basic_tech_zh_en.tsv'),           // zh \t en (基础中英技术词)
  glossaryNouns: join(DERIVED, 'terms', 'glossaries_nouns.tsv'),       // term \t noun1,noun2,...
  // CFN 中文语义框架词表(work 模式发散; frame→words JSON)
  cfnLex: join(LEXBASE, 'CFN-Lex', 'CFN_LEX_CN.json'),
  // THUOCL 域词表(mode 消歧: IT vs animal)
  thuoclIt: join(LEXBASE, 'THUOCL', 'data', 'THUOCL_IT.txt'),
  thuoclAnimal: join(LEXBASE, 'THUOCL', 'data', 'THUOCL_animal.txt'),
  // DomainWordsDict 计算机业(code/work 域扩展)
  domainWordsIt: join(LEXBASE, 'DomainWordsDict', 'data', '计算机业.txt'),
  // moetype ACG 专名词典(20万+ 角色名/作品名/ACG术语)
  moetypeDict: join(LEXBASE, 'moetype', 'tone_moe.dict.yaml'),
};

const cache = new Map();
function memo(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

// 可缺资源的统一形态: 缺 → {available:false, why},白盒可见;在 → {available:true, data}
function optional(key, path, build) {
  return memo(key, () => {
    if (!existsSync(path)) return { available: false, why: `missing: ${path}` };
    try {
      return { available: true, data: build(path) };
    } catch (e) {
      return { available: false, why: `load error: ${e.message}` };
    }
  });
}

// ---- SWOW 联想网络: cue → [{word, strength}] 按 strength 降序 ----
function buildSwow(path) {
  const map = new Map();
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [cue, resp, s] = lines[i].split('\t');
    if (!cue || !resp) continue;
    if (!map.has(cue)) map.set(cue, []);
    map.get(cue).push({ word: resp, strength: parseFloat(s) || 1 });
  }
  for (const arr of map.values()) arr.sort((a, b) => b.strength - a.strength);
  return map;
}
export const loadSwowZh = () => optional('swowZh', PATHS2.swowZh, buildSwow);
export const loadSwowEn = () => optional('swowEn', PATHS2.swowEn, buildSwow);

// ---- ConceptNet 倒排: word → [[rel, target, weight]] (rel 带~后缀=反向边) ----
export const loadConceptnetZh = () => optional('cnZh', PATHS2.conceptnetZh,
  p => JSON.parse(readFileSync(p, 'utf8')));
export const loadConceptnetEn = () => optional('cnEn', PATHS2.conceptnetEn,
  p => JSON.parse(readFileSync(p, 'utf8')));

// ---- 词林: 词 → [编码...] + 编码 → 词集(只用 = 同义行,# 相关行降权,@ 独立行忽略) ----
export const loadCilin = () => optional('cilin', PATHS2.cilin, (p) => {
  const wordToCodes = new Map();
  const codeToWords = new Map();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const [code, wordsStr] = line.split('\t');
    if (!code || !wordsStr) continue;
    const words = wordsStr.trim().split(/\s+/);
    codeToWords.set(code, words);
    for (const w of words) {
      if (!wordToCodes.has(w)) wordToCodes.set(w, []);
      wordToCodes.get(w).push(code);
    }
  }
  // 层级前缀索引(设计§发散·词林: 同大类L3+同中类L2): L3=小类前4位, L2=中类前2位
  const smallToWords = new Map(), midToWords = new Map();
  for (const [code, words] of codeToWords) {
    if (!code.endsWith('=')) continue; // 层级扩展同样只用同义行
    for (const [key, m] of [[code.slice(0, 4), smallToWords], [code.slice(0, 2), midToWords]]) {
      if (!m.has(key)) m.set(key, new Set());
      for (const w of words) m.get(key).add(w);
    }
  }
  return { wordToCodes, codeToWords, smallToWords, midToWords };
});

// ---- NRC 情绪词表: word → {emotion: 0|1} (标准 Wordlevel 三列 word\temotion\tflag) ----
export const loadNrc = () => optional('nrc', PATHS2.nrcDir, (dir) => {
  const file = findFile(dir, n => /wordlevel|emotion-lexicon/i.test(n) && n.endsWith('.txt'));
  if (!file) throw new Error('NRC wordlevel txt not found');
  const map = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const [w, emo, flag] = line.split('\t');
    if (!w || !emo || flag !== '1') continue;
    if (!map.has(w)) map.set(w, []);
    map.get(w).push(emo);
  }
  return map;
});

// ---- EmoBank: 句子级 VAD 原始语料 ----
// 消费现状: 仅 resourceReport2 清点;打分层词级 VAD 查询走 loadEmobankVad(派生表 emobank_word_vad.tsv),
// 本函数保留=原始语料可达性证明 + 未来句子级用途,不在打分链上
export const loadEmobank = () => optional('emobank', PATHS2.emobankDir, (dir) => {
  const file = findFile(dir, n => n.toLowerCase() === 'emobank.csv') || findFile(dir, n => n.endsWith('.csv'));
  if (!file) throw new Error('emobank csv not found');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const header = lines[0].split(',');
  const vi = header.indexOf('V'), ai = header.indexOf('A'), di = header.indexOf('D');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length <= Math.max(vi, ai, di)) continue;
    rows.push({ v: +c[vi], a: +c[ai], d: +c[di], text: c.slice(di + 1).join(',') });
  }
  return rows;
});

// ---- concreteness-78k(英文补充卷): 列名探测 word+conc ----
export const loadConc78k = () => optional('conc78k', PATHS2.conc78kDir, (dir) => {
  const file = findFile(dir, n => /\.(csv|tsv|txt)$/i.test(n), f => statSync(f).size > 100000);
  if (!file) throw new Error('conc78k data file not found');
  const raw = readFileSync(file, 'utf8').split(/\r?\n/);
  const delim = raw[0].includes('\t') ? '\t' : ',';
  const header = raw[0].split(delim).map(s => s.trim().toLowerCase());
  const wi = header.findIndex(h => h === 'word' || h === 'words');
  const ci = header.findIndex(h => h.includes('conc'));
  if (wi < 0 || ci < 0) throw new Error(`conc78k 列探测失败: ${header.join(',')}`);
  const map = new Map();
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i].split(delim);
    if (c[wi] && c[ci]) map.set(c[wi].toLowerCase(), parseFloat(c[ci]));
  }
  return map;
});

// ---- ECDICT: 英文词频 frq(0=未收录) ----
export const loadEcdictFrq = () => optional('ecdict', PATHS2.ecdict, (p) => {
  const map = new Map();
  // ecdict.csv 66MB,流式逐行;标准列: word,...,frq 在第10列(index 9),以表头核对
  const raw = readFileSync(p, 'utf8').split(/\r?\n/);
  const header = raw[0].split(',');
  const wi = header.indexOf('word'), fi = header.indexOf('frq');
  if (wi < 0 || fi < 0) throw new Error(`ecdict 表头异常: ${header.slice(0, 12).join(',')}`);
  for (let i = 1; i < raw.length; i++) {
    // 简易 csv: definition 含逗号但 word 在首列且 frq 是尾部数字列——用 split 后按位取,
    // 引号包裹的行跳过精确解析,只取首列不含引号的行(足够覆盖普通词条)
    const line = raw[i];
    if (!line || line[0] === '"') continue;
    const c = line.split(',');
    if (c.length <= fi) continue;
    const frq = parseInt(c[fi], 10);
    if (Number.isFinite(frq) && frq > 0) map.set(c[wi].toLowerCase(), frq);
  }
  return map;
});

// ---- ATOMIC2020: P1 专用过滤版 csv (head,relation,tail,knowledge_type,split; 94万行) ----
const ATOMIC_RELS_CHAT = new Set(['xWant', 'xEffect', 'xReact', 'oReact']); // 设计: 不选 xNeed/xAttr
export const loadAtomic = () => optional('atomic', PATHS2.atomicDir, (dir) => {
  const f = findFile(dir, x => x === 'atomic2020_p1_filtered.csv');
  if (!f) throw new Error('atomic2020_p1_filtered.csv not found');
  const index = new Map();   // word → [{r,t,h}] h=head序号(事件模板交集定位用)
  const heads = [];
  let edges = 0, skippedCols = 0;
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length !== 5) { skippedCols++; continue; } // head/tail 含逗号的行放弃,白盒计数
    const [head, rel, tail] = cols;
    if (!head || !ATOMIC_RELS_CHAT.has(rel) || !tail || tail === 'none') continue;
    const h = heads.length;
    heads.push(head);
    edges++;
    for (const w of head.toLowerCase().replace(/person[xy]|___/g, ' ').split(/\W+/)) {
      if (w.length < 3) continue;
      if (!index.has(w)) index.set(w, []);
      const arr = index.get(w);
      if (arr.length < 30) arr.push({ rel, tail, h });
    }
  }
  return { index, heads, edges, skippedCols };
});

// ---- code/work 术语与缩写表(抓取后落 derived/terms,缺=unavailable) ----
const buildTwoCol = p => {
  const map = new Map();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const [a, b] = line.split('\t');
    if (a && b) map.set(a.trim().toLowerCase(), b.trim());
  }
  return map;
};
export const loadAbbrCode = () => optional('abbrCode', PATHS2.abbrCode, buildTwoCol);
export const loadSeAbbr = () => optional('seAbbr', PATHS2.seAbbr, buildTwoCol);
export const loadComputerese = () => optional('computerese', PATHS2.computerese, buildTwoCol); // en→zh
export const loadAiTerms = () => optional('aiTerms', PATHS2.aiTerms, buildTwoCol);             // zh→en
export const loadGlossaries = () => optional('glossaries', PATHS2.glossaries, buildTwoCol);    // term→def
const buildTwoColKeepCase = p => {
  const map = new Map();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const [a, b] = line.split('\t');
    if (a && b) map.set(a.trim(), b.trim());
  }
  return map;
};
export const loadBasicTech = () => optional('basicTech', PATHS2.basicTech, buildTwoColKeepCase); // zh→en
export const loadGlossaryNouns = () => optional('glossaryNouns', PATHS2.glossaryNouns, p => {
  const map = new Map();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const [term, nouns] = line.split('\t');
    if (term && nouns) map.set(term.trim().toLowerCase(), nouns.trim().split(',').filter(n => n.length > 2));
  }
  return map;
}); // term → [noun1, noun2, ...]
// DomainWordsDict: 领域词典目录,做 jieba 自定义词典源(word 列表)
export const loadDomainWords = () => optional('domainWords', PATHS2.domainWordsDir, (dir) => {
  const set = new Set();
  for (const f of walkFiles(dir)) {
    if (!/\.(txt|csv)$/i.test(f) || statSync(f).size > 20 * 1024 * 1024) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const w = line.split(/[\t,]/)[0].trim();
      if (w && w.length >= 2 && w.length <= 12) set.add(w);
    }
  }
  return set;
});

// ---- CFN 中文语义框架(设计§work: CFN=✓; frame→words JSON → 反向索引 word→frames + frame→words) ----
export const loadCfnLex = () => optional('cfnLex', PATHS2.cfnLex, (p) => {
  const raw = JSON.parse(readFileSync(p, 'utf8')); // { frameName: [word...] }
  const wordToFrames = new Map(); // word → [frameName...]
  const frameToWords = new Map(); // frameName → [word...]
  for (const [frame, words] of Object.entries(raw)) {
    frameToWords.set(frame, words);
    for (const w of words) {
      if (!wordToFrames.has(w)) wordToFrames.set(w, []);
      wordToFrames.get(w).push(frame);
    }
  }
  return { wordToFrames, frameToWords };
});

// ---- EmoBank 词级 VAD(设计§标注打分 审查机制2: emobank[word]→{V,A,D};句子级语料词级聚合派生) ----
export const loadEmobankVad = () => optional('emobankVad', join(DERIVED, 'emobank_word_vad.tsv'), (p) => {
  const map = new Map();
  const lines = readFileSync(p, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [w, v, a, d] = lines[i].split('\t');
    if (w && v) map.set(w, { v: +v, a: +a, d: +d });
  }
  return map;
});

// ---- THUOCL 域词表(mode 消歧: code/work 看 IT 词表, chat/airp 看 animal 词表排除错域) ----
function buildWordFreqSet(path) {
  const set = new Set();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const w = line.split('\t')[0].trim();
    if (w && w.length >= 2) set.add(w);
  }
  return set;
}
export const loadThuoclIt = () => optional('thuoclIt', PATHS2.thuoclIt, buildWordFreqSet);
export const loadThuoclAnimal = () => optional('thuoclAnimal', PATHS2.thuoclAnimal, buildWordFreqSet);
export const loadDomainWordsIt = () => optional('domainWordsIt', PATHS2.domainWordsIt, buildWordFreqSet);

// ---- moetype ACG 专名词典(Rime YAML 格式: YAML header → ... → word\tpinyin 行) ----
export const loadMoetypeAcg = () => optional('moetypeAcg', PATHS2.moetypeDict, (path) => {
  const set = new Set();
  let afterHeader = false;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!afterHeader) {
      if (line.trim() === '...') afterHeader = true;
      continue;
    }
    const w = line.split('\t')[0].trim();
    if (w && w.length >= 2) set.add(w);
  }
  return set;
});

// ---- 工具 ----
function walkFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}
function findFile(dir, nameTest, fileTest = () => true) {
  if (!existsSync(dir)) return null;
  for (const p of walkFiles(dir)) {
    const base = p.split('\\').pop();
    if (nameTest(base) && fileTest(p)) return p;
  }
  return null;
}

export function clearResourceCaches() { cache.clear(); }

export function resourceReport2() {
  const size = r => (r.available
    ? (r.data.size ?? r.data.index?.size ?? r.data.wordToCodes?.size ?? (Array.isArray(r.data) ? r.data.length : Object.keys(r.data).length))
    : `✗(${r.why?.slice(0, 60)})`);
  return {
    swowZh: size(loadSwowZh()), swowEn: size(loadSwowEn()),
    conceptnetZh: size(loadConceptnetZh()), conceptnetEn: size(loadConceptnetEn()),
    cilin: size(loadCilin()), nrc: size(loadNrc()), emobank: size(loadEmobank()),
    conc78k: size(loadConc78k()), ecdictFrq: size(loadEcdictFrq()), atomic: size(loadAtomic()),
    abbrCode: size(loadAbbrCode()), seAbbr: size(loadSeAbbr()), computerese: size(loadComputerese()),
    aiTerms: size(loadAiTerms()), glossaries: size(loadGlossaries()),
    basicTech: size(loadBasicTech()), glossaryNouns: size(loadGlossaryNouns()),
    domainWords: size(loadDomainWords()),
    cfnLex: size(loadCfnLex()),
    thuoclIt: size(loadThuoclIt()), thuoclAnimal: size(loadThuoclAnimal()),
    domainWordsIt: size(loadDomainWordsIt()), moetypeAcg: size(loadMoetypeAcg()),
  };
}
