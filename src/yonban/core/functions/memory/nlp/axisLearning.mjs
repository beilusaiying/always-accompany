// axisLearning.mjs — P1 多轴自学习 + 打字式词频学习（实时层 + P9 整理层算法）
//
// 功能链：p1_pipeline(异步 fire-and-forget) → accumulateAxisStats(recalledRecords) → vocab/user/axis_stats.json
//         p1_pipeline → accumulateWordFreq(inputWords) → vocab/user/word_freq.json
//         memoryRecall → userFreqBoost(word, wordFreqMap) → 升权系数（打字式词频 log 归一）
// why：P1 发散权重应随用户习惯自动校准（常用词升权，陌生词普通），避免每次手动调参；
//      实时写盘是 fire-and-forget 不阻塞主链路，P9 离线 batch 再做精化。
// 关联链：
//   ← p1_pipeline.mjs（每轮 accumulateAxisStats / accumulateWordFreq，userCtx 门控）
//   ← memoryRecall.mjs（userFreqBoost 在点11 IDF 打分时调用）
//   → vocab/user/axis_stats.json / word_freq.json / user_cooccur.json / new_words.json（per-char 写盘）
// 影响范围：异步写 vocab/user/ 下 JSON 文件；userFreqBoost 纯计算只读
// 凛倾: "参考打字工具, 经常出现的可以记录" + "ai自己做词库才是最优"
//
// 三层学习:
//   [轴学习]   每轮对话 P1 召回后,累积 axis_alignment → axis_weights 校准
//   [词频学习] 每轮记录用户输入词频 → P1发散时常用词升权(像输入法)
//   [缺失检测] 标记P1词库没有的词 → P9联网补充
//
// 输出文件(per-char):
//   memory/vocab/user/axis_stats.json     {axis: {sum, count, avg}}  轴累积
//   memory/vocab/user/axis_weights.json   {axis: number}             P9 校准产出
//   memory/vocab/user/word_freq.json      {word: count}              词频(vocab.mjs已有freq_stats)
//   memory/vocab/user/user_cooccur.json   {"w1|w2": count}           相邻词共现对
//   memory/vocab/user/new_words.json      {word: {count, first}}     缺失词
//
// vocab.mjs已有freq_stats/cooccur/user_preferred三项数据采集
// 本模块提供: 升权函数(给P1用) + 缺失词检测(给P9用)

import fs from "fs/promises";
import path from "path";
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { readJsonSafe } from "../../../../../scripts/safeJsonIO.mjs"; // T019：词频/共现/新词损坏不静默清空重建，备份后抛错（上游p1_pipeline旁路catch+wbD留痕）
import { withFileLock } from "../storage_mod/storage.mjs"; // 每轮 fire-and-forget 累积写盘的 read-modify-write 串行化（消除并发轮次 lost-update，与 taskStore/setDataActions 同一收口）

// === 实时层(打字机制): 累积 axis_alignment ===

/**
 * 每轮对话 P1 召回后调用
 * @param {string} userVocabDir - memory/vocab/user/ 路径
 * @param {Array} recalledRecords - P1 召回的记忆(含 axes 字段)
 * @param {Object} options - { mainAIQuoted: 主AI 是否实际引用了某些记忆 }
 */
export async function accumulateAxisStats(userVocabDir, recalledRecords, options = {}) {
  wbT(null, "axisLearning", "accumulateAxisStats:enter", { recordCount: recalledRecords?.length, userVocabDir });
  if (!Array.isArray(recalledRecords) || recalledRecords.length === 0) return;

  const file = path.join(userVocabDir, "axis_stats.json");
  // 并发轮次(用户快连/多窗口同角色)下 fire-and-forget 调用会交错读改写、后写覆盖前写累积 → lost-update。
  // 整个 read-modify-write 串行到本文件锁内(与 taskStore/setDataActions 同一 withFileLock 收口)。
  return withFileLock(file, async () => {
    let stats = {};
    try {
      stats = JSON.parse(await fs.readFile(file, "utf-8"));
    } catch {
      stats = {};
    }

    const quoted = new Set(options.mainAIQuoted || []);

    for (const rec of recalledRecords) {
      const axes = rec.axes;
      if (!axes) continue;
      // 主 AI 引用的记忆权重 ×2(凛倾§16.16: 主 AI 实际选了的更说明该轴有用)
      const weight = quoted.has(rec.recordId || rec.id) ? 2 : 1;
      for (const [axisName, alignVal] of Object.entries(axes)) {
        if (!stats[axisName]) stats[axisName] = { sum: 0, count: 0, avg: 0 };
        stats[axisName].sum += (alignVal || 0) * weight;
        stats[axisName].count += weight;
        stats[axisName].avg = stats[axisName].sum / stats[axisName].count;
      }
    }

    await fs.mkdir(userVocabDir, { recursive: true });
    wbT(null, "axisLearning", "accumulateAxisStats:writeFile", { file });
    await fs.writeFile(file, JSON.stringify(stats, null, 2), "utf-8");
    wbT(null, "axisLearning", "accumulateAxisStats:done", { axisCount: Object.keys(stats).length });
    return stats;
  });
}

// === 整理层(P9): 校准 axis_weights ===

/**
 * P9 元 AI 调用: 用 axis_stats 累积统计校准 axis_weights
 * 平滑更新,不一次性翻盘(learnRate 加权,见下方 new = old×(1-lr) + target×lr)
 * TODO(待凛倾确认): 此处引 §16.14 D.3,但文件头(行2)引 §16.16,两处 section 号不一致,需对设计文档核对统一
 *
 * @param {string} userVocabDir
 * @param {Object} options - { learnRate: 0.3 (新统计权重), defaultBaseline: {...} }
 */
export async function calibrateAxisWeights(userVocabDir, options = {}) {
  wbT(null, "axisLearning", "calibrateAxisWeights:enter", { userVocabDir, learnRate: options.learnRate ?? 0.3 });
  const learnRate = options.learnRate ?? 0.3;
  const defaultBaseline = options.defaultBaseline || {
    emotion: 1.0,
    modern_pos: 1.0,
    paren_dual: 1.0,
    tech_emotion: 1.0,
    time_projection: 1.0,
    acg_reference: 1.0,
  };

  // 读累积统计
  const statsFile = path.join(userVocabDir, "axis_stats.json");
  let stats = {};
  try {
    stats = JSON.parse(await fs.readFile(statsFile, "utf-8"));
  } catch {
    wbD(null, "axisLearning", "calibrateAxisWeights:noStats", false, "无累积统计,跳过", { userVocabDir });
    return null;  // 无累积,跳过
  }

  // 读现有 weights(没有用 default)
  const weightsFile = path.join(userVocabDir, "axis_weights.json");
  let weights = { ...defaultBaseline };
  try {
    weights = { ...defaultBaseline, ...JSON.parse(await fs.readFile(weightsFile, "utf-8")) };
  } catch {}

  // 平滑更新: new = old × (1-learnRate) + (avg / 全局均值) × learnRate
  // 全局均值: 所有轴 avg 的均值,作为基线归一化
  const avgs = Object.values(stats).map(s => s.avg).filter(v => Number.isFinite(v));
  const globalMean = avgs.length ? avgs.reduce((a, b) => a + b) / avgs.length : 0.5;

  const minSamples = options.minSamples ?? 20;
  const newWeights = {};
  const reportLines = [];
  for (const axisName of Object.keys(defaultBaseline)) {
    const old = weights[axisName] ?? 1.0;
    const stat = stats[axisName];
    if (!stat || stat.count < minSamples) {
      newWeights[axisName] = old;  // 数据不足,保留旧值
      reportLines.push(`  ${axisName}: ${old.toFixed(2)} (data insufficient: ${stat?.count ?? 0} < ${minSamples})`);
      continue;
    }
    const ratio = globalMean > 0 ? stat.avg / globalMean : 1.0;
    const target = Math.max(0.5, Math.min(2.0, ratio));  // 限制范围 0.5-2.0
    const updated = old * (1 - learnRate) + target * learnRate;
    newWeights[axisName] = +updated.toFixed(3);
    reportLines.push(`  ${axisName}: ${old.toFixed(2)} → ${newWeights[axisName].toFixed(2)} (avg=${stat.avg.toFixed(2)} count=${stat.count})`);
  }

  wbT(null, "axisLearning", "calibrateAxisWeights:writeFile", { weightsFile, axisCount: Object.keys(newWeights).length });
  await fs.writeFile(weightsFile, JSON.stringify(newWeights, null, 2), "utf-8");
  wbT(null, "axisLearning", "calibrateAxisWeights:done", { newWeights });
  return { weights: newWeights, report: reportLines.join("\n") };
}

// === 加载: P1 启动时用 ===

export async function loadAxisWeights(userVocabDir) {
  const file = path.join(userVocabDir, "axis_weights.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;  // 上层用 DEFAULT
  }
}

// === 重置统计(P9 校准后清零, 不让旧数据无限累积) ===

export async function resetAxisStats(userVocabDir) {
  const file = path.join(userVocabDir, "axis_stats.json");
  try {
    await fs.unlink(file);
  } catch {}
}

// === 打字式词频学习(凛倾: "参考打字工具, 经常出现的可以记录") ===
// 每轮P1运行后调用, 记录:
//   word_freq.json    {word: count}          用户常用词升权
//   user_cooccur.json {"w1|w2": count}       用户共现词对
//   new_words.json    {word: {count, first}}  P1词库缺失的词

/**
 * 记录用户输入词频+共现+缺失词
 * @param {string} userVocabDir - memory/vocab/user/
 * @param {string[]} inputWords - 本轮BCC分词结果
 * @param {Object} options - { knownWords: Set (P1已有词库), maxNewWords: 500 }
 */
export async function accumulateWordFreq(userVocabDir, inputWords, options = {}) {
  wbT(null, "axisLearning", "accumulateWordFreq:enter", { wordCount: inputWords?.length, userVocabDir });
  if (!Array.isArray(inputWords) || inputWords.length === 0) return;
  await fs.mkdir(userVocabDir, { recursive: true });

  // 三份累积文件(word_freq/user_cooccur/new_words)均为 read-modify-write，且由 p1_pipeline
  // fire-and-forget 每轮调用；并发轮次交错会丢累积。以 freqFile 为锁键把整段串行化
  // (与 accumulateAxisStats/taskStore 同一 withFileLock 收口，同 userVocabDir 的写彼此排队)。
  const freqFile = path.join(userVocabDir, "word_freq.json");
  return withFileLock(freqFile, async () => {
    // 1. 词频累积(schema {词:{c,t}}: c=次数, t=最后出现天序号 = 三层激活的频率层+时间层地基)
    //   旧 schema 是 {词:数字}; 读到 number 视作 {c:number,t:0}(迁移容错, t=0 → 时间分最低, 旧数据自然沉降).
    // T019：损坏→备份.corrupt.bak后抛错（p1_pipeline:476旁路catch→wbD），不空表顶上写回清空积累。
    const freq = await readJsonSafe(freqFile, {});
    const _today = Math.floor(Date.now() / 86400000); // 天序号(epoch 天), 整数省空间
    for (const w of inputWords) {
      if (w.length < 2) continue;
      const cur = freq[w];
      const c = (typeof cur === "number" ? cur : (cur && cur.c) || 0) + 1;
      freq[w] = { c, t: _today };
    }
    wbT(null, "axisLearning", "accumulateWordFreq:writeFreq", { freqFile });
    await fs.writeFile(freqFile, JSON.stringify(freq), "utf-8");

    // 2. 共现累积(相邻词对)
    const coFile = path.join(userVocabDir, "user_cooccur.json");
    const cooccur = await readJsonSafe(coFile, {}); // T019：同上
    for (let i = 0; i < inputWords.length - 1; i++) {
      const a = inputWords[i], b = inputWords[i + 1];
      if (a.length < 2 || b.length < 2) continue;
      const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
      cooccur[pair] = (cooccur[pair] || 0) + 1;
    }
    wbT(null, "axisLearning", "accumulateWordFreq:writeCooccur", { coFile });
    await fs.writeFile(coFile, JSON.stringify(cooccur), "utf-8");

    // 3. 缺失词检测
    const knownWords = options.knownWords;
    if (knownWords && knownWords.size > 0) {
      const maxNew = options.maxNewWords ?? 500;
      const newFile = path.join(userVocabDir, "new_words.json");
      const newWords = await readJsonSafe(newFile, {}); // T019：同上
      for (const w of inputWords) {
        if (w.length < 2 || knownWords.has(w)) continue;
        if (Object.keys(newWords).length >= maxNew && !newWords[w]) continue;
        if (!newWords[w]) newWords[w] = { count: 0, first: new Date().toISOString().slice(0, 10) };
        newWords[w].count++;
      }
      await fs.writeFile(newFile, JSON.stringify(newWords, null, 2), "utf-8");
    }
  });
}

/**
 * 加载用户词频(P1启动时, 用于升权)
 * @returns {Object|null} {word: count}
 */
export async function loadWordFreq(userVocabDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(userVocabDir, "word_freq.json"), "utf-8"));
  } catch { return null; }
}

/**
 * 加载用户共现(作为per-user cooccur补充)
 * @returns {Object|null} {"w1|w2": count}
 */
export async function loadUserCooccur(userVocabDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(userVocabDir, "user_cooccur.json"), "utf-8"));
  } catch { return null; }
}

/**
 * 计算用户词频升权(像输入法: 常打的词排前面)
 * 算法: 次线性 TF 阻尼(sublinear term frequency, log(1+count)) — 信息检索标配, 高频词收益递减.
 * @param {string} word
 * @param {Object} wordFreq - {word: count}
 * @returns {number} min(0.3, log(1+count)*0.1) — 已按设计§5c缩放+封顶, 上界 0.3
 *
 * 设计§5c(03b_记忆召回重写): 缩放×0.1 后封顶 0.3, 用作字面维 TF×IDF 的 (1+boost) ≤1.3×,
 *   保证用户词频"锦上添花"不喧宾夺主(不盖过 idf 稀有度/层级重要性).
 */
export function userFreqBoost(word, wordFreq) {
  if (!wordFreq || !wordFreq[word]) return 0;
  const e = wordFreq[word];
  const c = typeof e === "number" ? e : (e && e.c) || 0; // 迁移容错: 旧 number / 新 {c,t}
  if (!c) return 0;
  // 设计§5c: min(0.3, log(1+count)*0.1) — 次线性 TF 阻尼 + 缩放 + 封顶
  return Math.min(0.3, Math.log(1 + c) * 0.1);
}
