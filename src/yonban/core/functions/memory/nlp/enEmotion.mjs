// enEmotion.mjs — 英文情感词典加载 + 查分（VADER 7520词 + AFINN 3382词 + ECDICT 词形还原）
//
// 功能链：wordCoords.mjs:loadWordCoords → loadVader / loadAfinn → _vader/_afinn Map；getEnEmotionScore(word) → valence 值
// why：英文词 hardcode 情感分（如 hn=0.428）是资源缺失导致锁死；加载 VADER/AFINN 两库合并取最优，
//      ECDICT 词形还原让 "loved/loves" 映射到 "love" 提高命中率。
// 关联链：
//   ← wordCoords.mjs（loadWordCoords 内初始化英文情感资源）
//   ← p1_axis.mjs / p1_node3_axis6.mjs（心理轴英文词情感打分）
//   → P1资源库/（vader_lexicon.txt / AFINN-111.csv / ecdict_lemma.json）
// 影响范围：只读 P1资源库 英文词典（进程级懒加载；资源缺失时该词返回 undefined，不崩）

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// P0-2 起统一走 p1_resdir.mjs；0803 收口为本次启动的唯一 P1_RESOURCE_DIR。
import { findResource } from "../p1/p1_resdir.mjs";

let _vader = null;
let _afinn = null;
let _lemma = null;
let _loaded = false;

function ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  _vader = new Map();
  _afinn = new Map();
  _lemma = new Map();

  // VADER
  const vaderPath = findResource(path.join("english", "vaderSentiment", "vaderSentiment", "vader_lexicon.txt"));
  if (vaderPath) {
    try {
      for (const line of fs.readFileSync(vaderPath, "utf-8").split("\n")) {
        const [word, score] = line.split("\t");
        if (word && score) _vader.set(word.trim().toLowerCase(), parseFloat(score));
      }
    } catch (e) { console.warn("[enEmotion] VADER load fail:", e?.message); }
  }

  // AFINN
  const afinnPath = findResource(path.join("english", "sentibank", "sentibank", "dict_arXiv", "AFINN", "AFINN_v2015.csv"));
  if (afinnPath) {
    try {
      const txt = fs.readFileSync(afinnPath, "utf-8").split("\n").slice(1);
      for (const line of txt) {
        const comma = line.lastIndexOf(",");
        if (comma < 0) continue;
        const word = line.slice(0, comma).trim().toLowerCase();
        const score = parseInt(line.slice(comma + 1));
        if (Number.isFinite(score)) _afinn.set(word, score / 5);  // 归一 -1..+1
      }
    } catch (e) { console.warn("[enEmotion] AFINN load fail:", e?.message); }
  }

  // lemma
  const lemmaPath = findResource(path.join("ECDICT", "lemma.en.txt"));
  if (lemmaPath) {
    try {
      for (const line of fs.readFileSync(lemmaPath, "utf-8").split("\n")) {
        if (line.startsWith(";") || !line.includes("->")) continue;
        const [lhs, rhs] = line.split("->");
        const lemma = (lhs.split("/")[0] || "").trim().toLowerCase();
        for (const form of (rhs || "").split(",")) {
          _lemma.set(form.trim().toLowerCase(), lemma);
        }
      }
    } catch (e) { console.warn("[enEmotion] lemma load fail:", e?.message); }
  }
  console.log(`[enEmotion] VADER=${_vader.size} AFINN=${_afinn.size} lemma=${_lemma.size}`);
}

// 单词情感分 -1..+1 (查询顺序: 先词形还原 lemma 再原词; VADER 优先于 AFINN)
// 归一口径: VADER 原值 -4..+4 此处 ÷4; AFINN 已在 ensureLoaded 加载时 ÷5, 此处直接用
export function wordScore(raw) {
  ensureLoaded();
  const w = String(raw).toLowerCase();
  const lem = _lemma.get(w) || w;
  if (_vader.has(lem)) return _vader.get(lem) / 4;
  if (_vader.has(w)) return _vader.get(w) / 4;
  if (_afinn.has(lem)) return _afinn.get(lem);
  if (_afinn.has(w)) return _afinn.get(w);
  return null;
}

// 文本情感极性: { pos, neg, net, hits }
export function textEmotion(text) {
  ensureLoaded();
  if (!text) return { pos: 0, neg: 0, net: 0, hits: 0 };
  const tokens = String(text).toLowerCase().match(/[a-z']+/g) || [];
  let pos = 0, neg = 0, hits = 0;
  for (const tok of tokens) {
    const s = wordScore(tok);
    if (s === null) continue;
    hits++;
    if (s > 0) pos += s;
    else neg += Math.abs(s);
  }
  const total = pos + neg || 1;
  return { pos: pos / total, neg: neg / total, net: (pos - neg) / total, hits };
}

// 检测语言: zh/en/ja
export function detectLang(text) {
  if (!text) return "zh";
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return "ja";
  return /[a-zA-Z]{3,}/.test(text) && !/[\u4e00-\u9fff]/.test(text) ? "en" : "zh";
}
