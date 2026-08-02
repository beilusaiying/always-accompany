// ════════════════════════════════════════════════════════════════════
// typingActivation.mjs — 打字式热词库三层激活（频率≥2 ∧ 时间衰减 ∧ 记忆有落点 → 激活词）
//
// 功能链：memoryRecall → computeTypingActive(memDirs, wordFreqMap) → Map<word, activationScore>（激活词 → 升权系数）
// why：用户高频说的词应在召回侧点1b额外提取并升权（参考打字软件词频记录）；
//      三层门控（freq/时间/记忆有落点）防一次性噪声词污染热词库。
// 关联链：
//   ← memoryRecall.mjs（点1c 额外激活词提取 + 点11 lexical 打分升权）
//   ← axisLearning.mjs（accumulateWordFreq 写入 word_freq.json，本模块读取）
//   → vocab/user/word_freq.json（per-char，{词:{c,t}} 格式）
// 影响范围：只读 word_freq.json + memDirs/*.json（mtime 缓存防重扫）；无数据时零行为变化
// ════════════════════════════════════════════════════════════════════
// 凛倾 2026-06-03: "设定激活, 只有用户提出 2 次左右才激活, 进入打字式的热词库."
//   "可以定 2, 然后加上时间, 还有看系统保存的, 进行算法, 也就是 3 层的. 完整全面的做."
//
// 一个用户输入词要"激活"进打字式热词库(供召回点1b额外提取/升权), 须过三层:
//   层1·频率: word_freq[词].c >= 2          (新词发现标准 freq>2, 挡一次性噪声)
//   层2·时间: recency = 0.995^(距今天数)      (近期常用排前, 陈旧自然沉降; 作 score 因子, 非硬门, 不误杀老词)
//   层3·系统保存: 词出现在已保存的三层记忆(hot/warm/cold)正文里 (用户提了2次但记忆无落点的纯口水不进库)
//   激活 = 层1 ∧ 层3, 激活分 = log(1+c) × recency(层2)
//
// 数据来源: word_freq.json(schema {词:{c,t}}, axisLearning.accumulateWordFreq 每轮累积; 旧 number 容错).
// 记忆扫描: memDirs(角色级+全局)下 .json 正文, mtime 缓存(照 vocabPacks._sig 套路, 记忆不变不重扫).
// 无数据 = 空激活集(零行为变化, 召回侧不受影响).
// ════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

export const TYPING_ACTIVATE_MIN_COUNT = 2;   // 层1 频率门(凛倾"定2" = 新词发现 freq>2)
export const TYPING_RECENCY_BASE = 0.995;     // 层2 时间衰减底(per-day; 召回 recDecay 同式, 时标按天)
const MAX_MEM_FILE = 500 * 1024;              // 与召回 MAX_FILE_SIZE 一致, 超大文件跳过

function _num(e) { return typeof e === "number" ? e : (e && e.c) || 0; }      // 频率(旧 number / 新 {c,t})
function _ts(e) { return (e && typeof e === "object" && e.t) || 0; }          // 最后出现天序号
function _mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function _readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// ── 递归收集 memDirs 下 .json 文件(用于 L3 系统保存扫描) ──
function _collectFiles(dir, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "vocab") _collectFiles(full, out); } // vocab/ 是料不是记忆正文, 跳过
    else if (e.name.endsWith(".json")) out.push(full);
  }
}

// ── L3 记忆正文(拼接串, mtime 缓存) ── 候选词量小, includes 检查可接受
const _memCache = new Map(); // key(dirs join) → { sig, text }
function _loadMemoryText(memDirs) {
  const dirs = (Array.isArray(memDirs) ? memDirs : [memDirs]).filter(Boolean);
  if (dirs.length === 0) return "";
  const files = [];
  for (const d of dirs) _collectFiles(d, files);
  files.sort();
  let sig = "";
  for (const f of files) sig += f + ":" + _mtime(f) + "|";
  const key = dirs.join("\u0000");
  const cached = _memCache.get(key);
  if (cached && cached.sig === sig) return cached.text;
  let text = "";
  for (const f of files) {
    try { if (fs.statSync(f).size > MAX_MEM_FILE) continue; text += fs.readFileSync(f, "utf8") + "\n"; } catch {}
  }
  _memCache.set(key, { sig, text });
  return text;
}

/**
 * 三层激活: 从 word_freq + 系统记忆算出激活的打字式热词集.
 * @param {string} userVocabDir - memory/vocab/user/
 * @param {string[]|string} memDirs - 召回遍历的记忆根(角色级 + 全局), 用于层3"看系统保存的"
 * @param {Object} opts - { minCount, memText(预载正文, 省重扫) }
 * @returns {{activeSet: Set<string>, scores: Object<string,number>}}
 */
export function computeTypingActive(userVocabDir, memDirs, opts = {}) {
  const EMPTY = { activeSet: new Set(), scores: {} };
  if (!userVocabDir) return EMPTY;
  const freq = _readJson(path.join(userVocabDir, "word_freq.json"));
  if (!freq || typeof freq !== "object") return EMPTY;
  const minCount = opts.minCount ?? TYPING_ACTIVATE_MIN_COUNT;
  const today = Math.floor(Date.now() / 86400000);

  // 层1 频率门: 先筛 count>=minCount(候选量小, 后续记忆检查才划算)
  const cand = [];
  for (const [w, e] of Object.entries(freq)) {
    if (w.length < 2) continue;
    const c = _num(e);
    if (c >= minCount) cand.push({ w, c, t: _ts(e) });
  }
  if (cand.length === 0) return EMPTY;

  // 层3 系统保存门: 词须出现在已保存的三层记忆正文里
  const memText = opts.memText != null ? opts.memText : _loadMemoryText(memDirs);

  const activeSet = new Set(), scores = {};
  for (const { w, c, t } of cand) {
    if (memText && !memText.includes(w)) continue; // L3 fail → 不激活(无 memText 时不卡, 退化为 L1∧L2)
    const ageDays = Math.max(0, today - t);
    const recency = Math.pow(TYPING_RECENCY_BASE, ageDays); // 层2
    activeSet.add(w);
    scores[w] = Math.log(1 + c) * recency;
  }
  return { activeSet, scores };
}

export default { computeTypingActive, TYPING_ACTIVATE_MIN_COUNT, TYPING_RECENCY_BASE };
