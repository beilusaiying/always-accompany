// escalationLex.mjs — escalation 语义词集（词林同小类扩散 + DLUT 情感词典 + 否定词典，广度 14-300+）
//
// 功能链：getPromptHandler / replyHandler → getEscalationWords(category) → Set<string>（各 escalation 类别词集）
// why：旧版硬编码正则 6-8 词触发"场景广度对不上"；改用词林同小类扩散 + 资源库词集，
//      自动覆盖长尾表达，无需人工维护词表。
// 关联链：
//   ← getPromptHandler（escalation 信号检测时调用）
//   → cilin.json（lib/，词林同小类词群扩散）
//   → P1资源库/（DLUT-Emotionontology 情感词汇.csv / chinese_dictionary/dict_negative.txt）
// 影响范围：只读 cilin.json + P1资源库 词典（进程级懒加载 Map；资源缺失降级到硬编码集合）
//
// 资源:
//   - cilin.json (本目录, 77456 词 / 17809 编码)
//   - DLUT-Emotionontology 情感词汇.csv (P1 资源库)
//   - chinese_dictionary/dict_negative.txt (1517 否定词)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// P0-2 起统一走 p1_resdir.mjs；0803 收口为本次启动的唯一 P1_RESOURCE_DIR。
import { findResource } from "../p1/p1_resdir.mjs";

const CILIN_PATH = path.join(__dirname, "..", "cilin.json");

let _lex = null;
let _loaded = false;

// 从词林种子词扩散到同小类全部词(凛倾要的"广度")
// 同小类 = 编码前 5 字符相同(Aa01A 级别)
function expandByCilin(cilin, seeds) {
  const result = new Set();
  const w2c = cilin.word2codes || {};
  const c2w = cilin.code2words || {};
  for (const seed of seeds) {
    result.add(seed);
    const codes = w2c[seed] || [];
    for (const code of codes) {
      // 同 code 全部词(同义)
      for (const w of (c2w[code] || [])) result.add(w);
      // 同小类(前 5 字符)
      const prefix = code.substring(0, 5);
      for (const [otherCode, words] of Object.entries(c2w)) {
        if (otherCode.startsWith(prefix) && otherCode !== code) {
          for (const w of words) result.add(w);
        }
      }
    }
  }
  return result;
}

function loadDLUTEmotionWords() {
  const csvPath = findResource(path.join("DLUT-Emotionontology", "情感词汇", "情感词汇.csv"));
  const result = {
    neg: new Set(),       // 极性=2 贬义
    pos: new Set(),       // 极性=1 褒义
    all: new Set(),
    byCategory: {},        // PA乐/PE好/NA怒/NB哀/NI惧/NC恶/ND惊
  };
  if (!csvPath) {
    console.warn("[escalationLex] DLUT 情感词汇.csv 未找到");
    return result;
  }
  try {
    const lines = fs.readFileSync(csvPath, "utf-8").split("\n").slice(1);
    for (const line of lines) {
      const parts = line.split(",").map(s => s.trim());
      if (parts.length < 7) continue;
      const word = parts[0];
      const category = parts[4];
      const intensity = parseFloat(parts[5]);
      const polarity = parseInt(parts[6]);
      if (!word || !category) continue;
      result.all.add(word);
      const bigCat = category.charAt(0); // P 褒 / N 贬
      const subCat = category.substring(0, 2); // PA/PE/NA/NB/NI/NC/ND
      if (!result.byCategory[subCat]) result.byCategory[subCat] = new Set();
      result.byCategory[subCat].add(word);
      // intensity 阈值 >=5 只收强情感词, 过滤弱情感噪声(polarity: 1=褒 2=贬)
      if (polarity === 2 && intensity >= 5) result.neg.add(word);
      if (polarity === 1 && intensity >= 5) result.pos.add(word);
    }
  } catch (e) {
    console.warn("[escalationLex] DLUT load fail:", e.message);
  }
  return result;
}

function loadNegationWords() {
  const negPath = findResource(path.join("chinese_dictionary", "dict_negative.txt"));
  const set = new Set();
  if (!negPath) return set;
  try {
    for (const line of fs.readFileSync(negPath, "utf-8").split("\n")) {
      const word = (line.split("\t")[0] || "").trim();
      if (word) set.add(word);
    }
  } catch {}
  return set;
}

function loadAntonymPairs() {
  const antPath = findResource(path.join("chinese_dictionary", "dict_antonym.txt"));
  const map = new Map();
  if (!antPath) return map;
  try {
    for (const line of fs.readFileSync(antPath, "utf-8").split("\n")) {
      const parts = line.split("——");
      if (parts.length === 2) {
        const a = parts[0].trim();
        const b = parts[1].trim();
        if (a && b) {
          map.set(a, b);
          map.set(b, a);
        }
      }
    }
  } catch {}
  return map;
}

function ensureLoaded() {
  if (_loaded) return _lex;
  _loaded = true;
  let cilin;
  try {
    cilin = JSON.parse(fs.readFileSync(CILIN_PATH, "utf-8"));
  } catch (e) {
    console.warn("[escalationLex] cilin.json load fail:", e.message);
    cilin = { word2codes: {}, code2words: {} };
  }

  // 各信号种子词(扩散后覆盖几十-几百词, 凛倾要的"广度")
  const causalitySeeds = ["因为", "所以", "导致", "起因", "由于", "缘于", "因此", "致使", "造成", "使得", "促成"];
  const conjSeeds = ["而且", "另外", "并且", "同时", "此外", "顺便", "再就是"];
  const reasoningSeeds = ["如果", "假设", "那么", "推断", "证明", "推测", "推理", "为什么", "假如", "倘若", "假定", "推论"];
  const compareSeeds = ["类似", "相似", "好比", "犹如", "如同", "比如", "像", "类比"];
  const timeAnchorSeeds = ["还记得", "以前", "第一次", "那时候", "上次", "那天", "上回", "之前"];

  const dlut = loadDLUTEmotionWords();
  const negation = loadNegationWords();
  const antonymMap = loadAntonymPairs();

  _lex = {
    causality: expandByCilin(cilin, causalitySeeds),
    conjunction: expandByCilin(cilin, conjSeeds),
    reasoning: expandByCilin(cilin, reasoningSeeds),
    compare: expandByCilin(cilin, compareSeeds),
    timeAnchor: expandByCilin(cilin, timeAnchorSeeds),
    emotion_neg: dlut.neg,
    emotion_pos: dlut.pos,
    emotion_all: dlut.all,
    emotion_byCategory: dlut.byCategory,
    negation,
    antonymMap,
  };

  console.log(
    `[escalationLex] loaded:` +
    ` causality=${_lex.causality.size}` +
    ` conj=${_lex.conjunction.size}` +
    ` reasoning=${_lex.reasoning.size}` +
    ` compare=${_lex.compare.size}` +
    ` timeAnchor=${_lex.timeAnchor.size}` +
    ` emo_neg=${_lex.emotion_neg.size}` +
    ` emo_pos=${_lex.emotion_pos.size}` +
    ` emo_all=${_lex.emotion_all.size}` +
    ` neg=${_lex.negation.size}` +
    ` ant=${_lex.antonymMap.size}`
  );

  return _lex;
}

export function getEscalationLex() {
  return ensureLoaded();
}

// 工具: 给定词数组, 返回每个 lex 集合的命中数 + 命中词
export function probeAllLex(words) {
  const lex = ensureLoaded();
  const result = {};
  for (const [name, set] of Object.entries(lex)) {
    if (set instanceof Set) {
      const hits = words.filter(w => set.has(w));
      if (hits.length) result[name] = hits;
    }
  }
  return result;
}
