// bccDomain.mjs — BCC 三领域词频差分（对话/文学/新闻三域比例 → 场景识别 + modern_pos 计算）
//
// 功能链：p1_axis.mjs:scoreWord → wordDomainDist(word) → {dialogue, literature, news} 三域比例（进程级懒加载缓存）
// why：BCC 三域差分可作粗粒度场景信号（dialogue>0.45 → 心理/社交轴）；
//      替代旧 hardcode modern_pos=0.75 stub，用真实数据驱动场景识别。
// 关联链：
//   ← p1_axis.mjs（scoreWord BCC 路径，BCC 比例决定子轴默认归属）
//   ← p1_node4_axis47.mjs（路径4 BCC 占比命中探测）
//   → P1资源库/BCC-corpus/（dialogue_word_freq/literature/news_total 三个词频文件）
// 影响范围：只读 P1资源库 BCC 词频文件（_domains Map，进程级懒加载，缺资源不崩返回空对象）
// 用途:
//   1) 真实 modern_pos 计算(替代旧 hardcode 0.75 stub);
//      消费方: selfDrivenP1.mjs computeModernInfoPosition()(grep "computeModernPos" 定位),委托本文件 computeModernPos
//   2) 自动场景识别(dialogue/literature/news/general)
//
// 资源(P1 资源库 BCC-corpus/):
//   - dialogue_word_freq.txt    142580 词 (日常对话)
//   - literature_word_freq.txt  215429 词 (文学/小说)
//   - news_total_word_freq.txt  591368 词 (新闻/时事)
//   - multi_domain_total_word_freq.txt 436410 词 (跨领域综合, 用作别处 BCC 主词典; 本模块不加载, 仅用上面三领域做差分)

import fs from "fs";
import path from "path";

// P0-2 起统一走 p1_resdir.mjs；0803 收口为本次启动的唯一 P1_RESOURCE_DIR。
// 原本地 RESOURCE_CANDIDATES 第二候选是 "<PROJECT_ROOT>" 字面量死路径, 从未命中过。
import { findResource } from "../p1/p1_resdir.mjs";

let _domains = null;
let _loaded = false;

export function getBccDomainCacheStats() {
  if (!_domains) return { loaded: _loaded, domains: 0, buckets: 0 };
  const values = Object.values(_domains);
  return {
    loaded: _loaded,
    domains: values.length,
    buckets: values.reduce((sum, domain) => sum + (domain?.freq?.size || 0), 0),
  };
}

export function clearBccDomainCache() {
  _domains = null;
  _loaded = false;
}

function loadDomainFreq(filename) {
  const p = findResource(path.join("BCC-corpus", filename));
  if (!p) return { freq: new Map(), total: 0 };
  const freq = new Map();
  let total = 0;
  try {
    const text = fs.readFileSync(p, "utf-8");
    const lines = text.split("\n");
    // skip header "token,count"
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const commaIdx = line.lastIndexOf(",");
      if (commaIdx <= 0) continue;
      const token = line.slice(0, commaIdx).trim();
      const count = parseInt(line.slice(commaIdx + 1));
      if (!token || !Number.isFinite(count)) continue;
      freq.set(token, count);
      total += count;
    }
  } catch (e) {
    console.warn(`[bccDomain] ${filename} load fail:`, e.message);
  }
  return { freq, total };
}

function ensureLoaded() {
  if (_loaded) return _domains;
  _loaded = true;

  const dialogue = loadDomainFreq("dialogue_word_freq.txt");
  const literature = loadDomainFreq("literature_word_freq.txt");
  const news = loadDomainFreq("news_total_word_freq.txt");

  _domains = { dialogue, literature, news };

  console.log(
    `[bccDomain] loaded: dialogue=${dialogue.freq.size}/${dialogue.total} ` +
    `literature=${literature.freq.size}/${literature.total} ` +
    `news=${news.freq.size}/${news.total}`
  );

  return _domains;
}

// 给定词在某领域的归一频率(token freq / total) — 越高表示该词在该领域越常见
function normFreq(domain, word) {
  const c = domain.freq.get(word) || 0;
  return c / Math.max(1, domain.total);
}

// 一个词的领域分布(softmax over 三领域 freq 比例)
export function wordDomainDist(word) {
  const d = ensureLoaded();
  const fd = normFreq(d.dialogue, word);
  const fl = normFreq(d.literature, word);
  const fn = normFreq(d.news, word);
  const sum = fd + fl + fn;
  if (sum <= 0) return null;
  return { dialogue: fd / sum, literature: fl / sum, news: fn / sum };
}

// 整段文本的领域 profile: 每个词的分布加权平均
// 返回 { dialogue, literature, news, dominant, sceneFrame }
export function getBccDomainProfile(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return { dialogue: 0.33, literature: 0.34, news: 0.33, dominant: "general", coverage: 0 };
  }
  ensureLoaded();
  let sumD = 0, sumL = 0, sumN = 0;
  let covered = 0;
  for (const w of words) {
    if (!w || w.length < 2) continue;
    const dist = wordDomainDist(w);
    if (!dist) continue;
    sumD += dist.dialogue;
    sumL += dist.literature;
    sumN += dist.news;
    covered++;
  }
  if (covered === 0) {
    return { dialogue: 0.33, literature: 0.34, news: 0.33, dominant: "general", coverage: 0 };
  }
  const dialogue = sumD / covered;
  const literature = sumL / covered;
  const news = sumN / covered;
  const max = Math.max(dialogue, literature, news);
  let dominant = "general";
  // 0.42 阈值: 略高于均分 1/3, 三领域无明显偏向时判 general(不强行归类)
  if (max > 0.42) {
    if (dialogue === max) dominant = "dialogue";
    else if (literature === max) dominant = "literature";
    else dominant = "news";
  }
  return { dialogue, literature, news, dominant, coverage: covered / words.length };
}

// modern_pos 真计算(凛倾§16.16 stub → 真值)
// 凛倾§16.33 调: dialogue=日常现代, news=正式现代, literature=文学/古典
// 公式: modern_pos = dialogue + 0.5 * news (literature 不计) —— 与下方 return 代码一致,本文件自洽
// TODO(待凛倾确认): selfDrivenP1.mjs computeModernInfoPosition 注释写的是 "1 - literature 占比",
//   两处口径不同(此处是当前真正执行的公式)。需统一注释,避免读者误判。
// 返回 0.0(纯文学) ~ 1.0(纯日常对话)
//   - 0.0-0.3: 文学/角色扮演场景
//   - 0.3-0.6: 混合或新闻偏正式
//   - 0.6-1.0: 日常对话
export function computeModernPos(words) {
  const profile = getBccDomainProfile(words);
  return profile.dialogue + 0.5 * profile.news;
}
