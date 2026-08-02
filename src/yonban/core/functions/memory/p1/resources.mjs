// resources.mjs — 词表资源统一加载层(懒加载+进程内缓存)
//
// 设计来源: P1_新管线设计_算法标注版.md §收集·过滤 / §英文过滤
// 白盒要求: 每份资源加载后上报 {path, entries},缺失如实抛错不静默降级——
// 资源缺失=管线该停,吞掉会让过滤层静默失效(反馈·删除恢复配对反演+吞错共模)
//
// 数据格式(2026-08-01 实测,信实际文件不信文档):
//   BCC: CSV "token,count" 带表头 / meld_sch: 本项目转换的 TSV "word\tconc_m"
//   brysbaert: TSV 表头 Word/Bigram/Conc.M/... / 停用词: 每行一词

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DERIVED } from './resources2.mjs';

const LEXBASE = 'D:\\shajiuguan\\p1shiyanshi\\09_P1自驱动_专项\\06_资源库_词库\\P1资源库';
export const PATHS = {
  stopwordsCN: [
    `${LEXBASE}\\cn_stopwords\\cn_stopwords.txt`,
    `${LEXBASE}\\cn_stopwords\\baidu_stopwords.txt`,
    `${LEXBASE}\\cn_stopwords\\hit_stopwords.txt`,
    `${LEXBASE}\\cn_stopwords\\scu_stopwords.txt`,
  ],
  bccDialogue: `${LEXBASE}\\BCC-corpus\\dialogue_word_freq.txt`,
  bccMulti: `${LEXBASE}\\BCC-corpus\\multi_domain_total_word_freq.txt`,
  meldSch: join(DERIVED, 'meld_sch_concreteness.tsv'),
  brysbaert: `${LEXBASE}\\brysbaert_concreteness.txt`,
  coreNatureDict: `${LEXBASE}\\CoreNatureDictionary.txt`,
};

const cache = new Map();
function memo(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

// 中文停用词: 4 表取并集(设计"不需要担心误杀",误杀有回捞兜底)
export function loadStopwordsCN() {
  return memo('stopCN', () => {
    const set = new Set();
    for (const p of PATHS.stopwordsCN) {
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const w = line.trim();
        if (w) set.add(w);
      }
    }
    return set;
  });
}

// BCC 词频: dialogue 与 multi_domain 两表,查询取两者 max(任一语域超高频即功能词)
function loadFreqCsv(path) {
  const map = new Map();
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) { // 跳过表头 token,count
    const comma = lines[i].lastIndexOf(','); // 词面可含逗号,频次固定在行尾 → 按最后一个逗号切,防含逗号词条错切
    if (comma <= 0) continue;
    const w = lines[i].slice(0, comma);
    const n = parseInt(lines[i].slice(comma + 1), 10);
    if (w && Number.isFinite(n)) map.set(w, n);
  }
  return map;
}
export function loadBcc() {
  return memo('bcc', () => ({
    dialogue: loadFreqCsv(PATHS.bccDialogue),
    multi: loadFreqCsv(PATHS.bccMulti),
  }));
}
export function bccFreq(word) {
  const { dialogue, multi } = loadBcc();
  return Math.max(dialogue.get(word) ?? 0, multi.get(word) ?? 0);
}

// meld_sch 中文具体性(9877 双字词)
// 量表方向 2026-08-01 实测确诊: 原表 1=具体 5=抽象(苹果1.259 vs 抽象4.423),与 brysbaert 相反,
// 读 conc_aligned 列(6-raw,统一 5=具体),转换在 convert_meld.py,证据同文件注释
export function loadMeldSch() {
  return memo('meld', () => {
    const map = new Map();
    const lines = readFileSync(PATHS.meldSch, 'utf8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const [w, , aligned] = lines[i].split('\t');
      if (w && aligned) map.set(w, parseFloat(aligned));
    }
    return map;
  });
}

// brysbaert 英文具体性(Conc.M 列, 1-5 量表)
export function loadBrysbaert() {
  return memo('brys', () => {
    const map = new Map();
    const lines = readFileSync(PATHS.brysbaert, 'utf8').split(/\r?\n/);
    const header = lines[0].split('\t');
    const wi = header.indexOf('Word');
    const ci = header.indexOf('Conc.M');
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (cols[wi] && cols[ci]) map.set(cols[wi].toLowerCase(), parseFloat(cols[ci]));
    }
    return map;
  });
}

// CoreNatureDictionary: 词→主词性(取频率最高的词性)
export function loadCoreNatureDict() {
  return memo('coreNature', () => {
    const map = new Map();
    const lines = readFileSync(PATHS.coreNatureDict, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const word = parts[0];
      let bestPos = parts[1], bestFreq = parseInt(parts[2], 10) || 0;
      for (let i = 3; i + 1 < parts.length; i += 2) {
        const f = parseInt(parts[i + 1], 10) || 0;
        if (f > bestFreq) { bestPos = parts[i]; bestFreq = f; }
      }
      map.set(word, bestPos.toLowerCase());
    }
    return map;
  });
}

// 资源清点(白盒: 管线启动时打印,一眼可见哪份表多大)
export function clearResourceCaches() { cache.clear(); }

export function resourceReport() {
  return {
    stopwordsCN: loadStopwordsCN().size,
    bccDialogue: loadBcc().dialogue.size,
    bccMulti: loadBcc().multi.size,
    meldSch: loadMeldSch().size,
    brysbaert: loadBrysbaert().size,
    coreNatureDict: loadCoreNatureDict().size,
  };
}
