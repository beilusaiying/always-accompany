// numberbatch.mjs — Numberbatch 中文向量加载模块（307K词 × 300维，cosine 邻居搜索）
//
// 功能链：p1_node2_swow / p1_axis / p1_transfer / p1_coord_bridge → getNumberbatch() → Map<word, Float32Array>（异步懒加载，进程级单例）
// why：NB300 是 P1 发散和坐标计算的向量基础（Speer&Lowry-Duda 2017）；二次启动读 .bin 缓存约快 5×；
//      全局单例避免 280MB 向量数据重复加载占用内存。
// 关联链：
//   ← p1_node2_swow.mjs / p1_node0_recall.mjs（NB cosine 质心/锚点计算）
//   ← p1_axis.mjs / p1_node3_axis6.mjs（NB 兜底近邻发散）
//   ← p1_transfer.mjs / p1_coord_bridge_precompute.mjs（桥接词 NB cosine）
// 影响范围：首次加载约 14s（流式读 txt 或 .bin 缓存）；写 numberbatch_zh.bin 缓存（二进制，加速再次启动）
// 加载: 流式读取 txt → 过滤纯中文2-6字 → Float32Array

import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getResDir } from "../p1/p1_resdir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZH_FILE = path.join(getResDir(), "numberbatch_zh.txt");
const BIN_FILE = path.join(getResDir(), "numberbatch_zh.bin");
const IDX_FILE = path.join(getResDir(), "numberbatch_zh_idx.json");

const DIMS = 300;
const ZH_RE = /^[\u4e00-\u9fff\u3400-\u4dbf]+$/;

let _vectors = null;
let _norms = null;
let _loading = null;

export async function loadNumberbatch() {
  if (_vectors) return _vectors;
  if (_loading) return _loading;
  _loading = _doLoad();
  return _loading;
}

export function getNumberbatch() {
  if (_vectors) return _vectors;
  if (fs.existsSync(BIN_FILE) && fs.existsSync(IDX_FILE)) {
    _loadBin();
  } else {
    // 响亮失败(2026-07-20): 此前静默return null → node2零扩散/node0锚点空级联无日志可查(查了3轮)。
    //   bin/idx 缺失时必须出声——消费端(node2/node0/axis/transfer)全部依赖此池, null=整条召回发散链退化。
    console.warn(`[numberbatch] NOT LOADED — bin/idx missing (${BIN_FILE}); downstream node2/node0/axis will degrade. Restore files or run loadNumberbatch() with txt source.`);
  }
  return _vectors;
}

export function getNumberbatchCacheStats() {
  return {
    loaded: _vectors instanceof Map,
    vectorCount: _vectors?.size || 0,
    normCount: _norms?.size || 0,
    loading: !!_loading && !_vectors,
  };
}

// 数据生命周期清理，不冒充 ESM 模块卸载。调用方必须先清掉持有 NB Map/
// Float32Array 引用的下游索引，再调用这里，随后 getNumberbatch 可从盘懒加载。
export function clearNumberbatchCache() {
  const before = getNumberbatchCacheStats();
  _vectors?.clear();
  _norms?.clear();
  _vectors = null;
  _norms = null;
  _loading = null;
  return before;
}

async function _doLoad() {
  if (fs.existsSync(BIN_FILE) && fs.existsSync(IDX_FILE)) {
    return _loadBin();
  }
  if (fs.existsSync(ZH_FILE)) {
    return _loadTxt();
  }
  console.warn("[numberbatch] no data files found");
  _vectors = new Map();
  _norms = new Map();
  return _vectors;
}

function _loadBin() {
  const start = Date.now();
  _vectors = new Map();
  _norms = new Map();
  const idx = JSON.parse(fs.readFileSync(IDX_FILE, "utf-8"));
  const buf = fs.readFileSync(BIN_FILE);
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  for (let i = 0; i < idx.length; i++) {
    const word = idx[i];
    const offset = i * DIMS;
    const vec = floats.slice(offset, offset + DIMS);
    let norm = 0;
    for (let d = 0; d < DIMS; d++) norm += vec[d] * vec[d];
    _vectors.set(word, vec);
    _norms.set(word, Math.sqrt(norm));
  }
  console.log(`[numberbatch] bin loaded: ${_vectors.size} words in ${Date.now() - start}ms`);
  // 加载英文Numberbatch(凛倾: "直接用英文,面向国际用户")
  // 真300维: numberbatch-en-19.08原库(516782×300)重建,与中文同一对齐空间。
  // 旧版numberbatch_en.json只有20维(被截断/降维),用Math.min补0到300导致中英不对齐 → 已废弃。
  const EN_BIN = path.join(getResDir(), "numberbatch_en.bin");
  const EN_IDX = path.join(getResDir(), "numberbatch_en_idx.json");
  if (fs.existsSync(EN_BIN) && fs.existsSync(EN_IDX)) {
    try {
      const enIdx = JSON.parse(fs.readFileSync(EN_IDX, "utf-8"));
      const enBuf = fs.readFileSync(EN_BIN);
      const enFloats = new Float32Array(enBuf.buffer, enBuf.byteOffset, enBuf.byteLength / 4);
      let enCount = 0;
      for (let i = 0; i < enIdx.length; i++) {
        const word = enIdx[i];
        if (_vectors.has(word)) continue;
        const vec = enFloats.slice(i * DIMS, i * DIMS + DIMS);
        let norm = 0;
        for (let d = 0; d < DIMS; d++) norm += vec[d] * vec[d];
        _vectors.set(word, vec);
        _norms.set(word, Math.sqrt(norm));
        enCount++;
      }
      console.log(`[numberbatch] en loaded: ${enCount} English words (300d real)`);
    } catch (e) { console.warn("[numberbatch] en load failed:", e.message); }
  } else {
    console.warn("[numberbatch] en 300d bin/idx not found, English vectors skipped");
  }
  // C7(154号): 技术词补充向量merge（照EN merge先例，失败恒无副作用）
  const TECH_BIN = path.join(getResDir(), "numberbatch_tech.bin");
  const TECH_IDX = path.join(getResDir(), "numberbatch_tech_idx.json");
  if (fs.existsSync(TECH_BIN) && fs.existsSync(TECH_IDX)) {
    try {
      const techIdx = JSON.parse(fs.readFileSync(TECH_IDX, "utf-8"));
      const techBuf = fs.readFileSync(TECH_BIN);
      const techFloats = new Float32Array(techBuf.buffer, techBuf.byteOffset, techBuf.byteLength / 4);
      let techCount = 0;
      for (let i = 0; i < techIdx.length; i++) {
        const word = techIdx[i];
        if (_vectors.has(word)) continue;
        const vec = techFloats.slice(i * DIMS, i * DIMS + DIMS);
        let norm = 0;
        for (let d = 0; d < DIMS; d++) norm += vec[d] * vec[d];
        _vectors.set(word, vec);
        _norms.set(word, Math.sqrt(norm));
        techCount++;
      }
      console.log(`[numberbatch] tech补充向量已merge: +${techCount}词 (idx ${techIdx.length})`);
    } catch (e) { console.warn("[numberbatch] tech补充向量加载失败（不影响主词表）:", e.message); }
  }
  // ── Phase3 TTEN+PCA去偏(CIKM2023+KDD2026) ──
  // 万金油术语在向量空间中范数大/方向趋同。L2归一化+PCA去第一主成分消除偏差。
  // alpha=0.3(保守,从低开始)
  const _DEBIAS_ALPHA = 0.3;
  try {
    const _allVecs = [..._vectors.values()];
    if (_allVecs.length > 1000) {
      const _ttenStart = Date.now();
      // Step 1: 计算均值
      const _mean = new Float32Array(DIMS);
      for (const v of _allVecs) for (let i = 0; i < DIMS; i++) _mean[i] += v[i];
      for (let i = 0; i < DIMS; i++) _mean[i] /= _allVecs.length;
      // Step 2: Power iteration找第一主成分(20轮收敛)
      let _pc1 = new Float32Array(DIMS);
      for (let i = 0; i < DIMS; i++) _pc1[i] = Math.sin(i * 0.1 + 0.7);
      for (let iter = 0; iter < 20; iter++) {
        const _next = new Float32Array(DIMS);
        for (const v of _allVecs) {
          let dot = 0;
          for (let i = 0; i < DIMS; i++) dot += (v[i] - _mean[i]) * _pc1[i];
          for (let i = 0; i < DIMS; i++) _next[i] += dot * (v[i] - _mean[i]);
        }
        let nm = 0;
        for (let i = 0; i < DIMS; i++) nm += _next[i] * _next[i];
        nm = Math.sqrt(nm);
        if (nm > 0) for (let i = 0; i < DIMS; i++) _pc1[i] = _next[i] / nm;
      }
      // Step 3: 去偏——减去pc1方向的投影
      for (const v of _allVecs) {
        let proj = 0;
        for (let i = 0; i < DIMS; i++) proj += v[i] * _pc1[i];
        for (let i = 0; i < DIMS; i++) v[i] -= _DEBIAS_ALPHA * proj * _pc1[i];
      }
      // Step 4: 重新计算norms(去偏后范数变了)
      for (const [word, v] of _vectors) {
        let nm = 0;
        for (let i = 0; i < DIMS; i++) nm += v[i] * v[i];
        _norms.set(word, Math.sqrt(nm));
      }
      console.log(`[numberbatch] TTEN debias done: ${_allVecs.length} vecs, alpha=${_DEBIAS_ALPHA}, ${Date.now() - _ttenStart}ms`);
    }
  } catch (e) { console.warn("[numberbatch] TTEN debias failed:", e.message); }
  return _vectors;
}

async function _loadTxt() {
  const start = Date.now();
  _vectors = new Map();
  _norms = new Map();

  const input = fs.createReadStream(ZH_FILE, { encoding: "utf-8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) continue;
    const word = line.slice(0, tabIdx);
    if (word.length < 2 || word.length > 6) continue;
    if (!ZH_RE.test(word)) continue;

    const parts = line.slice(tabIdx + 1).split(" ");
    if (parts.length !== DIMS) continue;

    const vec = new Float32Array(DIMS);
    let norm = 0;
    for (let i = 0; i < DIMS; i++) {
      vec[i] = parseFloat(parts[i]);
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm < 1e-8) continue;

    _vectors.set(word, vec);
    _norms.set(word, norm);
  }

  console.log(`[numberbatch] txt loaded: ${_vectors.size} words in ${Date.now() - start}ms`);

  _saveBin();
  return _vectors;
}

function _saveBin() {
  try {
    const words = [..._vectors.keys()];
    const buf = Buffer.alloc(words.length * DIMS * 4);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, words.length * DIMS);
    for (let i = 0; i < words.length; i++) {
      const vec = _vectors.get(words[i]);
      floats.set(vec, i * DIMS);
    }
    fs.writeFileSync(BIN_FILE, buf);
    fs.writeFileSync(IDX_FILE, JSON.stringify(words));
    console.log(`[numberbatch] saved bin cache: ${words.length} words`);
  } catch (e) {
    console.warn("[numberbatch] bin save failed:", e.message);
  }
}

export function cosineSimilarity(word1, word2) {
  if (!_vectors) return null;
  const v1 = _vectors.get(word1);
  const v2 = _vectors.get(word2);
  if (!v1 || !v2) return null;
  const n1 = _norms.get(word1);
  const n2 = _norms.get(word2);
  let dot = 0;
  for (let i = 0; i < DIMS; i++) dot += v1[i] * v2[i];
  return dot / (n1 * n2);
}

export function findNeighbors(word, { minSim = 0.3, maxSim = 0.7, topK = 10, maxLen = 4, exclude = null } = {}) {
  if (!_vectors) return [];
  const v = _vectors.get(word);
  if (!v) return [];
  const n = _norms.get(word);

  const results = [];
  for (const [w, wv] of _vectors) {
    if (w === word) continue;
    if (w.length > maxLen) continue;
    if (exclude && exclude.has(w)) continue;
    const wn = _norms.get(w);
    let dot = 0;
    for (let i = 0; i < DIMS; i++) dot += v[i] * wv[i];
    const sim = dot / (n * wn);
    if (sim >= minSim && sim <= maxSim) {
      results.push({ word: w, similarity: sim });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

export function findNeighborsBatch(sourceWords, { minSim = 0.3, maxSim = 0.7, topK = 5, maxLen = 4, exclude = null } = {}) {
  if (!_vectors) return new Map();
  const sources = [];
  for (const w of sourceWords) {
    const v = _vectors.get(w);
    if (!v) continue;
    sources.push({ word: w, vec: v, norm: _norms.get(w), results: [] });
  }
  if (sources.length === 0) return new Map();

  for (const [w, wv] of _vectors) {
    if (w.length > maxLen) continue;
    if (exclude && exclude.has(w)) continue;
    const wn = _norms.get(w);
    for (const src of sources) {
      if (w === src.word) continue;
      let dot = 0;
      for (let i = 0; i < DIMS; i++) dot += src.vec[i] * wv[i];
      const sim = dot / (src.norm * wn);
      if (sim >= minSim && sim <= maxSim) {
        src.results.push({ word: w, similarity: sim });
      }
    }
  }

  const out = new Map();
  for (const src of sources) {
    src.results.sort((a, b) => b.similarity - a.similarity);
    out.set(src.word, src.results.slice(0, topK));
  }
  return out;
}

export function findFromCentroid(words, { minSim = 0.25, maxSim = 0.50, topK = 5, maxLen = 4, exclude = null } = {}) {
  if (!_vectors || words.length === 0) return [];
  const centroid = new Float32Array(DIMS);
  let count = 0;
  for (const w of words) {
    const v = _vectors.get(w);
    if (!v) continue;
    for (let i = 0; i < DIMS; i++) centroid[i] += v[i];
    count++;
  }
  if (count === 0) return [];
  let cNorm = 0;
  for (let i = 0; i < DIMS; i++) { centroid[i] /= count; cNorm += centroid[i] * centroid[i]; }
  cNorm = Math.sqrt(cNorm);
  if (cNorm < 1e-8) return [];

  const wordSet = new Set(words);
  const results = [];
  for (const [w, wv] of _vectors) {
    if (wordSet.has(w)) continue;
    if (w.length > maxLen) continue;
    if (exclude && exclude.has(w)) continue;
    const wn = _norms.get(w);
    let dot = 0;
    for (let i = 0; i < DIMS; i++) dot += centroid[i] * wv[i];
    const sim = dot / (cNorm * wn);
    if (sim >= minSim && sim <= maxSim) {
      results.push({ word: w, similarity: sim });
    }
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

export function findBridge(word1, word2, { topK = 3, maxLen = 4, exclude = null } = {}) {
  if (!_vectors) return [];
  const v1 = _vectors.get(word1);
  const v2 = _vectors.get(word2);
  if (!v1 || !v2) return [];

  const midVec = new Float32Array(DIMS);
  let midNorm = 0;
  for (let i = 0; i < DIMS; i++) {
    midVec[i] = (v1[i] + v2[i]) / 2;
    midNorm += midVec[i] * midVec[i];
  }
  midNorm = Math.sqrt(midNorm);
  if (midNorm < 1e-8) return [];

  const results = [];
  for (const [w, wv] of _vectors) {
    if (w === word1 || w === word2) continue;
    if (w.length > maxLen) continue;
    if (exclude && exclude.has(w)) continue;
    const wn = _norms.get(w);
    let dot = 0;
    for (let i = 0; i < DIMS; i++) dot += midVec[i] * wv[i];
    const sim = dot / (midNorm * wn);
    if (sim >= 0.4 && sim <= 0.7) {
      results.push({ word: w, similarity: sim });
    }
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

// 路径B: 向量算术类比 (Mikolov 2013)
// A:B :: C:? → ? = C + (B - A) — 找与目标向量最近的词
// 例: 国王:王后 :: 男人:? → 女人; 攻击:伤害 :: 帮助:? → 治愈
export function findAnalogy(wordA, wordB, wordC, { topK = 3, maxLen = 4, minSim = 0.3, exclude = null } = {}) {
  if (!_vectors) return [];
  const vA = _vectors.get(wordA);
  const vB = _vectors.get(wordB);
  const vC = _vectors.get(wordC);
  if (!vA || !vB || !vC) return [];

  const target = new Float32Array(DIMS);
  let tNorm = 0;
  for (let i = 0; i < DIMS; i++) {
    target[i] = vC[i] + (vB[i] - vA[i]);
    tNorm += target[i] * target[i];
  }
  tNorm = Math.sqrt(tNorm);
  if (tNorm < 1e-8) return [];

  const skip = new Set([wordA, wordB, wordC]);
  const results = [];
  for (const [w, wv] of _vectors) {
    if (skip.has(w)) continue;
    if (w.length > maxLen) continue;
    if (exclude && exclude.has(w)) continue;
    const wn = _norms.get(w);
    let dot = 0;
    for (let i = 0; i < DIMS; i++) dot += target[i] * wv[i];
    const sim = dot / (tNorm * wn);
    if (sim >= minSim) {
      results.push({ word: w, similarity: sim });
    }
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

export function hasWord(word) {
  return _vectors ? _vectors.has(word) : false;
}

export function vectorSize() {
  return _vectors ? _vectors.size : 0;
}
