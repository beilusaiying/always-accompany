/**
 * vocab.mjs — 词表管理模块（停用词 + 情感/同义/反义词典，per-char 缓存）
 *
 * 功能链：p1_pipeline / memoryRecall → loadStopwords(memDir) / loadEmotionDict / loadSynonyms → Map/Set（进程级 per-char 缓存）
 * why：P1 分词 + 召回需频繁查停用词表和情感词典；按 memDir 隔离缓存，词库文件变更时下轮自动重载。
 * 关联链：
 *   ← p1_node1_tokenize.mjs / queryExpand.mjs（loadStopwords 过滤无信息词）
 *   ← memoryRecall.mjs / axisLearning.mjs（情感/同义词查询）
 * 影响范围：只读 memDir/vocab/ 下 JSON 文件；_stopwordsCache/_emotionCache/_synonymCache/_antonymCache 四个 Map 进程级
 *
 * @module vocab
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================
// 缓存声明
// ============================================================

/** @type {Map<string, Set<string>>} memDir → stopwords Set */
const _stopwordsCache = new Map();

/** @type {Map<string, Map<string, object>>} memDir → emotion Map */
const _emotionCache = new Map();

/** @type {Map<string, Map<string, string[]>>} memDir → synonym Map */
const _synonymCache = new Map();

/** @type {Map<string, Map<string, string[]>>} memDir → antonym Map */
const _antonymCache = new Map();

/** @type {Map<string, Set<string>>} memDir → negation Set */
const _negationCache = new Map();

// ============================================================
// 内置最小停用词集（172个高频虚词，资源缺失时兜底）
// ============================================================

const BUILTIN_STOPWORDS = [
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看",
  "好", "自己", "这", "他", "她", "它", "们", "那", "吗", "吧", "啊", "哦",
  "嗯", "呢", "啦", "呀", "哈", "嘿", "哎", "唉", "喂", "嗨",
  "这个", "那个", "什么", "怎么", "哪里", "为什么", "可以", "因为", "所以",
  "但是", "而且", "或者", "如果", "虽然", "不过", "然后", "已经", "正在",
  "还是", "应该", "可能", "一定", "必须", "需要", "想要", "能够",
  "比较", "非常", "特别", "真的", "其实", "大概", "一般", "一直",
  "这样", "那样", "这么", "那么", "怎样", "如何", "多少", "几个",
  "对于", "关于", "通过", "进行", "使用", "能", "会",
  "而", "且", "又", "及", "与", "或", "则", "便",
  "把", "被", "让", "给", "向", "从", "以", "按", "为",
  "所", "之", "其", "该", "此", "某", "每", "各", "各种",
  "等", "等等", "若", "若是", "倘若", "假如",
  "于是", "因此", "并且", "不但", "不仅",
  "尽管", "即使", "哪怕", "纵然",
  "总之", "另外", "此外", "除了", "除此之外",
  "首先", "其次", "最后", "接着",
  "大家", "别人", "他人", "对方",
  "这里", "那里", "这边", "那边",
  "现在", "马上", "立刻",
  "时候", "时间", "地方", "方面", "方式",
  "知道", "觉得", "认为", "希望", "打算",
  "这种", "那种", "哪种", "一些", "一点",
];

// ============================================================
// 通用加载工具
// ============================================================

/**
 * 从lib同目录加载JSON词典文件
 * @param {string} filename
 * @returns {object|null}
 */
function _loadCoreDictFile(filename) {
  try {
    const moduleDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
    const corePath = path.join(moduleDir, filename);
    if (fs.existsSync(corePath)) {
      return JSON.parse(fs.readFileSync(corePath, "utf-8"));
    }
  } catch { /* skip */ }
  return null;
}

// ============================================================
// 停用词
// ============================================================

/**
 * 加载停用词集合（带内存缓存）
 * 优先级：用户自定义 > 内置stopwords_core.json > BUILTIN_STOPWORDS
 * @param {string} memDir - 角色记忆目录
 * @returns {Set<string>}
 */
export function loadStopwords(memDir) {
  if (_stopwordsCache.has(memDir)) return _stopwordsCache.get(memDir);

  let stopwords = null;

  // 1. 用户自定义
  const userPath = path.join(memDir, "vocab", "core", "stopwords.json");
  if (fs.existsSync(userPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(userPath, "utf-8"));
      stopwords = new Set(Array.isArray(data) ? data : (data.words || []));
    } catch (e) {
      console.warn("[vocab] 用户停用词加载失败:", e.message);
    }
  }

  // 2. 内置stopwords_core.json
  if (!stopwords || stopwords.size === 0) {
    const data = _loadCoreDictFile("stopwords_core.json");
    if (data && Array.isArray(data)) {
      stopwords = new Set(data);
    }
  }

  // 3. 内置最小集兜底
  if (!stopwords || stopwords.size === 0) {
    stopwords = new Set(BUILTIN_STOPWORDS);
  }

  _stopwordsCache.set(memDir, stopwords);
  return stopwords;
}

/**
 * 判断是否停用词
 * @param {string} word
 * @param {Set<string>} stopwordsSet
 * @returns {boolean}
 */
export function isStopword(word, stopwordsSet) {
  return stopwordsSet.has(word);
}

// ============================================================
// 情感词典 — DLUT 27K词，7大类21小类
// ============================================================

/**
 * 加载情感词典
 * @param {string} memDir
 * @returns {Map<string, {cat: string, intensity: number, polarity: number}>}
 */
export function loadEmotionDict(memDir) {
  if (_emotionCache.has(memDir)) return _emotionCache.get(memDir);

  let dict = new Map();

  const userPath = path.join(memDir, "vocab", "core", "emotion_dict.json");
  if (fs.existsSync(userPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(userPath, "utf-8"));
      dict = new Map(Object.entries(data));
    } catch { /* skip */ }
  }

  if (dict.size === 0) {
    const data = _loadCoreDictFile("emotion_dict.json");
    if (data) dict = new Map(Object.entries(data));
  }

  _emotionCache.set(memDir, dict);
  return dict;
}

// ============================================================
// 同义词典 — Chinese-Synonyms 18K组
// ============================================================

/**
 * 加载同义词典
 * @param {string} memDir
 * @returns {Map<string, string[]>}
 */
export function loadSynonymDict(memDir) {
  if (_synonymCache.has(memDir)) return _synonymCache.get(memDir);

  let dict = new Map();

  const userPath = path.join(memDir, "vocab", "core", "synonym_dict.json");
  if (fs.existsSync(userPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(userPath, "utf-8"));
      dict = new Map(Object.entries(data));
    } catch { /* skip */ }
  }

  if (dict.size === 0) {
    const data = _loadCoreDictFile("synonym_dict.json");
    if (data) dict = new Map(Object.entries(data));
  }

  _synonymCache.set(memDir, dict);
  return dict;
}

// ============================================================
// 反义词典 — 18K对，双向
// ============================================================

/**
 * 加载反义词典
 * @param {string} memDir
 * @returns {Map<string, string[]>}
 */
export function loadAntonymDict(memDir) {
  if (_antonymCache.has(memDir)) return _antonymCache.get(memDir);

  let dict = new Map();

  const userPath = path.join(memDir, "vocab", "core", "antonym_dict.json");
  if (fs.existsSync(userPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(userPath, "utf-8"));
      dict = new Map(Object.entries(data));
    } catch { /* skip */ }
  }

  if (dict.size === 0) {
    const data = _loadCoreDictFile("antonym_dict.json");
    if (data) dict = new Map(Object.entries(data));
  }

  _antonymCache.set(memDir, dict);
  return dict;
}

// ============================================================
// 否定词 — 1500+个
// ============================================================

/**
 * 加载否定词集合
 * @param {string} memDir
 * @returns {Set<string>}
 */
export function loadNegationWords(memDir) {
  if (_negationCache.has(memDir)) return _negationCache.get(memDir);

  let words = new Set();

  const userPath = path.join(memDir, "vocab", "core", "negation_words.json");
  if (fs.existsSync(userPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(userPath, "utf-8"));
      words = new Set(Array.isArray(data) ? data : []);
    } catch { /* skip */ }
  }

  if (words.size === 0) {
    const data = _loadCoreDictFile("negation_words.json");
    if (data && Array.isArray(data)) words = new Set(data);
  }

  _negationCache.set(memDir, words);
  return words;
}

// ============================================================
// 缓存管理
// ============================================================

/**
 * 清除所有词表缓存（模式切换时调用）
 */
export function clearVocabCache() {
  _stopwordsCache.clear();
  _emotionCache.clear();
  _synonymCache.clear();
  _antonymCache.clear();
  _negationCache.clear();
}