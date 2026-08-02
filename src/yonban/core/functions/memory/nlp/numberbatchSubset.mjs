// numberbatchSubset.mjs — P1 召回末段专用的本地 offset 向量后端。
//
// 契约：
//   - 只按词读取固定 300d 向量，不提供全局 KNN。
//   - 冷初始化分块校验 bin SHA-256；通过后，向量数据只按 position*1200 读取。
//   - 对每个读取向量应用与 numberbatch.mjs 当前实现数值相同的 PC1 去偏。
//   - 缺参数、版本不一致、短读均响亮抛错；调用方决定是否显式退为稀疏输出。
//
// Redis KV 后端以后只需实现同一 getMany(words) 契约；算法层不依赖存储类型。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate as scheduleImmediate } from "node:timers";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.join(__dirname, "..");
const PARAMS_FILE = path.join(MEMORY_DIR, "numberbatch_tten_params.json");
const DIMS = 300;
const BYTES_PER_VECTOR = DIMS * Float32Array.BYTES_PER_ELEMENT;
const SOURCE_CODE_BASE = 1_000_000;
const DEFAULT_CACHE_MAX_VECTORS = 50_000;
const SOURCE_DEFS = [
  { name: "zh", idx: "numberbatch_zh_idx.json", bin: "numberbatch_zh.bin" },
  { name: "en", idx: "numberbatch_en_idx.json", bin: "numberbatch_en.bin" },
  { name: "tech", idx: "numberbatch_tech_idx.json", bin: "numberbatch_tech.bin" },
];

let _params = null;
let _locations = null;
let _sources = [];
let _vectorCache = new Map();
let _cacheMaxVectors = DEFAULT_CACHE_MAX_VECTORS;
let _cacheEvictions = 0;
let _indexLoadMs = 0;
let _integrityMs = 0;
let _integrityBytes = 0;
let _diskReads = 0;
let _diskBytes = 0;
let _loadPromise = null;
let _loadPromiseGeneration = null;
let _cacheGeneration = 0;
let _asyncInitStarts = 0;
let _asyncInitJoins = 0;
let _asyncGenerationWaits = 0;

const _sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// [0731 词库多段缓存 P0] bin 完整性校验结果备忘：path → {mtimeMs, size, sha256}。
// why：clearNumberbatchSubsetCache 全清后重建索引要对 767MB 原始 bin 重算全量 SHA256（实测 ~1.3s 纯 I/O+CPU），
//   而两次 idle 周期之间 bin 几乎不可能变——mtime+size 未变即复用上次算出的 hash（仍与 manifest 比对，
//   校验语义不变；文件真变了 stat 不匹配自动走全量重算）。同 mtime+size 的恶意篡改不在本地文件威胁模型内。
// 生命周期：刻意不随 clearNumberbatchSubsetCache 清除（它缓存的是"文件版本的事实"非运行时数据）。
const _binIntegrityMemo = new Map();
function _memoizedIntegrity(filePath, stat) {
  const memo = _binIntegrityMemo.get(filePath);
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) {
    return { sha256: memo.sha256, bytes: 0, ms: 0, memoized: true };
  }
  return null; // 未命中：调用方 compute 后用 _rememberIntegrity 存
}
function _rememberIntegrity(filePath, stat, sha256) {
  _binIntegrityMemo.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, sha256 });
}

function _sha256File(filePath) {
  const startedAt = Date.now();
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  let bytes = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest("hex"), bytes, ms: Date.now() - startedAt };
}

async function _sha256FileAsync(filePath, generation) {
  const startedAt = Date.now();
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  const handle = await fs.promises.open(filePath, "r");
  let bytes = 0;
  try {
    while (true) {
      _assertGeneration(generation);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes, ms: Date.now() - startedAt };
}

const _yieldToEventLoop = () => new Promise((resolve) => scheduleImmediate(resolve));

function _assertGeneration(generation) {
  if (generation !== _cacheGeneration) {
    throw new Error("Numberbatch subset cache cleared during initialization");
  }
}

function _validateParams(params) {
  if (params?.schema !== "beilu-numberbatch-tten-params-v1") {
    throw new Error(`unsupported Numberbatch subset params schema: ${params?.schema || "missing"}`);
  }
  if (params.dims !== DIMS || params.bytesPerVector !== BYTES_PER_VECTOR) {
    throw new Error("Numberbatch subset params dimension mismatch");
  }
  if (!Number.isFinite(params.alpha) || !Array.isArray(params.pc1) || params.pc1.length !== DIMS) {
    throw new Error("Numberbatch subset params missing alpha/pc1");
  }
  if (JSON.stringify(params.mergeOrder) !== JSON.stringify(SOURCE_DEFS.map((source) => source.name))) {
    throw new Error("Numberbatch subset merge order mismatch");
  }
}

function _paramsForRuntime(params) {
  return {
    alpha: params.alpha,
    pc1: Float32Array.from(params.pc1),
    vectorCount: params.vectorCount,
    manifestGeneratedAt: params.generatedAt,
  };
}

function _closeSources(sources, label) {
  for (const source of sources) {
    try {
      fs.closeSync(source.fd);
    } catch (error) {
      console.warn(`[numberbatchSubset] ${label} close failed:`, error?.message || error);
    }
  }
}

function _openSources(sourceRows) {
  const sources = [];
  try {
    for (const row of sourceRows) {
      sources.push({
        ...row.def,
        fd: fs.openSync(row.binPath, "r"),
        positions: row.positions,
        includedCount: row.includedCount,
      });
    }
    return sources;
  } catch (error) {
    _closeSources(sources, "rollback");
    throw error;
  }
}

function _publishLoadedState({
  params,
  locations,
  sources,
  integrityMs,
  integrityBytes,
  startedAt,
}, generation = null) {
  if (generation !== null) _assertGeneration(generation);
  _params = _paramsForRuntime(params);
  _locations = locations;
  _sources = sources;
  _integrityMs = integrityMs;
  _integrityBytes = integrityBytes;
  _indexLoadMs = Date.now() - startedAt;
}

function _resolveCacheMaxVectors(value) {
  const configured = Number(value);
  if (!Number.isFinite(configured)) return DEFAULT_CACHE_MAX_VECTORS;
  return Math.max(0, Math.min(SOURCE_CODE_BASE - 1, Math.trunc(configured)));
}

function _trimVectorCache(limit) {
  while (_vectorCache.size > limit) {
    const oldest = _vectorCache.keys().next().value;
    if (oldest === undefined) break;
    _vectorCache.delete(oldest);
    _cacheEvictions++;
  }
}

function _loadIndex() {
  if (_locations) return;
  if (_loadPromise) {
    throw new Error("Numberbatch subset async initialization is already in progress");
  }
  const startedAt = Date.now();
  const params = JSON.parse(fs.readFileSync(PARAMS_FILE, "utf8"));
  _validateParams(params);

  const locations = new Map();
  const sourceRows = [];
  let integrityMs = 0;
  let integrityBytes = 0;
  for (let sourceIndex = 0; sourceIndex < SOURCE_DEFS.length; sourceIndex++) {
    const def = SOURCE_DEFS[sourceIndex];
    const manifest = params.sources?.find((source) => source.name === def.name);
    if (!manifest || manifest.idx !== def.idx || manifest.bin !== def.bin) {
      throw new Error(`Numberbatch subset manifest missing source=${def.name}`);
    }
    const idxPath = path.join(MEMORY_DIR, def.idx);
    const binPath = path.join(MEMORY_DIR, def.bin);
    const idxBuffer = fs.readFileSync(idxPath);
    const words = JSON.parse(idxBuffer.toString("utf8"));
    if (!Array.isArray(words) || words.length !== manifest.idxCount) {
      throw new Error(`Numberbatch subset idx count mismatch: ${def.idx}`);
    }
    if (_sha256(idxBuffer) !== manifest.idxSha256) {
      throw new Error(`Numberbatch subset idx hash mismatch: ${def.idx}`);
    }
    const stat = fs.statSync(binPath);
    if (stat.size !== manifest.binBytes || stat.size !== words.length * BYTES_PER_VECTOR) {
      throw new Error(`Numberbatch subset bin size mismatch: ${def.bin}`);
    }
    let integrity = _memoizedIntegrity(binPath, stat); // [0731 P0] mtime+size 未变→复用已验 hash，免 1.3s 全量重算
    if (!integrity) {
      integrity = _sha256File(binPath);
      _rememberIntegrity(binPath, stat, integrity.sha256);
    }
    integrityBytes += integrity.bytes;
    integrityMs += integrity.ms;
    if (integrity.sha256 !== manifest.binSha256) {
      throw new Error(`Numberbatch subset bin hash mismatch: ${def.bin}`);
    }
    if (words.length >= SOURCE_CODE_BASE) {
      throw new Error(`Numberbatch subset source exceeds position encoding: ${def.name}`);
    }
    let includedCount = 0;
    for (let position = 0; position < words.length; position++) {
      const word = words[position];
      if (locations.has(word)) continue;
      locations.set(word, sourceIndex * SOURCE_CODE_BASE + position);
      includedCount++;
    }
    if (includedCount !== manifest.includedCount) {
      throw new Error(`Numberbatch subset merge count mismatch: ${def.name}`);
    }
    sourceRows.push({
      def,
      binPath,
      positions: words.length,
      includedCount,
    });
  }
  if (locations.size !== params.vectorCount) {
    throw new Error(`Numberbatch subset total count mismatch: ${locations.size} != ${params.vectorCount}`);
  }
  const sources = _openSources(sourceRows);
  _publishLoadedState({
    params,
    locations,
    sources,
    integrityMs,
    integrityBytes,
    startedAt,
  });
}

async function _buildIndexAsync(generation) {
  const startedAt = Date.now();
  const params = JSON.parse(await fs.promises.readFile(PARAMS_FILE, "utf8"));
  _assertGeneration(generation);
  _validateParams(params);

  const locations = new Map();
  const sourceRows = [];
  let integrityMs = 0;
  let integrityBytes = 0;
  for (let sourceIndex = 0; sourceIndex < SOURCE_DEFS.length; sourceIndex++) {
    _assertGeneration(generation);
    const def = SOURCE_DEFS[sourceIndex];
    const manifest = params.sources?.find((source) => source.name === def.name);
    if (!manifest || manifest.idx !== def.idx || manifest.bin !== def.bin) {
      throw new Error(`Numberbatch subset manifest missing source=${def.name}`);
    }
    const idxPath = path.join(MEMORY_DIR, def.idx);
    const binPath = path.join(MEMORY_DIR, def.bin);
    const [idxBuffer, stat] = await Promise.all([
      fs.promises.readFile(idxPath),
      fs.promises.stat(binPath),
    ]);
    _assertGeneration(generation);
    const words = JSON.parse(idxBuffer.toString("utf8"));
    if (!Array.isArray(words) || words.length !== manifest.idxCount) {
      throw new Error(`Numberbatch subset idx count mismatch: ${def.idx}`);
    }
    if (_sha256(idxBuffer) !== manifest.idxSha256) {
      throw new Error(`Numberbatch subset idx hash mismatch: ${def.idx}`);
    }
    if (stat.size !== manifest.binBytes || stat.size !== words.length * BYTES_PER_VECTOR) {
      throw new Error(`Numberbatch subset bin size mismatch: ${def.bin}`);
    }
    let integrity = _memoizedIntegrity(binPath, stat); // [0731 P0] 同步路径同款备忘：mtime+size 未变免全量重算
    if (!integrity) {
      integrity = await _sha256FileAsync(binPath, generation);
      _rememberIntegrity(binPath, stat, integrity.sha256);
    }
    integrityBytes += integrity.bytes;
    integrityMs += integrity.ms;
    _assertGeneration(generation);
    if (integrity.sha256 !== manifest.binSha256) {
      throw new Error(`Numberbatch subset bin hash mismatch: ${def.bin}`);
    }
    if (words.length >= SOURCE_CODE_BASE) {
      throw new Error(`Numberbatch subset source exceeds position encoding: ${def.name}`);
    }
    let includedCount = 0;
    for (let position = 0; position < words.length; position++) {
      const word = words[position];
      if (!locations.has(word)) {
        locations.set(word, sourceIndex * SOURCE_CODE_BASE + position);
        includedCount++;
      }
      if ((position + 1) % 16_384 === 0) {
        await _yieldToEventLoop();
        _assertGeneration(generation);
      }
    }
    if (includedCount !== manifest.includedCount) {
      throw new Error(`Numberbatch subset merge count mismatch: ${def.name}`);
    }
    sourceRows.push({
      def,
      binPath,
      positions: words.length,
      includedCount,
    });
  }
  if (locations.size !== params.vectorCount) {
    throw new Error(`Numberbatch subset total count mismatch: ${locations.size} != ${params.vectorCount}`);
  }

  _assertGeneration(generation);
  const sources = _openSources(sourceRows);
  try {
    _publishLoadedState({
      params,
      locations,
      sources,
      integrityMs,
      integrityBytes,
      startedAt,
    }, generation);
  } catch (error) {
    _closeSources(sources, "cancelled initialization");
    throw error;
  }
}

async function _loadIndexAsync() {
  if (_locations) return;
  if (_loadPromise) {
    const pending = _loadPromise;
    if (_loadPromiseGeneration === _cacheGeneration) {
      _asyncInitJoins++;
      await pending;
      return;
    }
    _asyncGenerationWaits++;
    try {
      await pending;
    } catch {
      // The old generation is expected to reject after clear. The new request
      // owns the current generation and restarts below instead of inheriting it.
    }
    return await _loadIndexAsync();
  }
  const generation = _cacheGeneration;
  _asyncInitStarts++;
  const promise = _buildIndexAsync(generation);
  _loadPromise = promise;
  _loadPromiseGeneration = generation;
  try {
    await promise;
  } finally {
    if (_loadPromise === promise) {
      _loadPromise = null;
      _loadPromiseGeneration = null;
    }
  }
}

function _getVector(word) {
  const cached = _vectorCache.get(word);
  if (cached) {
    _vectorCache.delete(word);
    _vectorCache.set(word, cached);
    return cached;
  }
  const code = _locations.get(word);
  if (code === undefined) return null;
  const sourceIndex = Math.trunc(code / SOURCE_CODE_BASE);
  const position = code - sourceIndex * SOURCE_CODE_BASE;
  const source = _sources[sourceIndex];
  if (!source) throw new Error(`Numberbatch subset invalid source code for word=${word}`);

  const raw = new Float32Array(DIMS);
  const bytes = Buffer.from(raw.buffer);
  const bytesRead = fs.readSync(
    source.fd,
    bytes,
    0,
    BYTES_PER_VECTOR,
    position * BYTES_PER_VECTOR,
  );
  if (bytesRead !== BYTES_PER_VECTOR) {
    throw new Error(`Numberbatch subset short read: source=${source.name} position=${position}`);
  }
  _diskReads++;
  _diskBytes += bytesRead;

  let projection = 0;
  for (let dimension = 0; dimension < DIMS; dimension++) {
    projection += raw[dimension] * _params.pc1[dimension];
  }
  const vector = new Float32Array(DIMS);
  for (let dimension = 0; dimension < DIMS; dimension++) {
    vector[dimension] = raw[dimension] - _params.alpha * projection * _params.pc1[dimension];
  }
  if (_cacheMaxVectors > 0) {
    _vectorCache.set(word, vector);
    _trimVectorCache(_cacheMaxVectors);
  }
  return vector;
}

function _getManyLoaded(words, options) {
  _cacheMaxVectors = _resolveCacheMaxVectors(options?.maxCacheVectors);
  _trimVectorCache(_cacheMaxVectors);
  const result = new Map();
  for (const word of new Set(Array.isArray(words) ? words : [...(words || [])])) {
    if (!word) continue;
    const vector = _getVector(word);
    if (vector) result.set(word, vector);
  }
  return result;
}

export function getNumberbatchSubset(words, options = null) {
  _loadIndex();
  return _getManyLoaded(words, options);
}

export async function getNumberbatchSubsetAsync(words, options = null) {
  await _loadIndexAsync();
  return _getManyLoaded(words, options);
}

export function getNumberbatchSubsetCacheStats() {
  return {
    indexLoaded: _locations instanceof Map,
    initializing: _loadPromise !== null,
    indexTerms: _locations?.size || 0,
    paramsLoaded: !!_params,
    cachedVectors: _vectorCache.size,
    cacheMaxVectors: _cacheMaxVectors,
    cacheEvictions: _cacheEvictions,
    openFiles: _sources.length,
    indexLoadMs: _indexLoadMs,
    integrityMs: _integrityMs,
    integrityBytes: _integrityBytes,
    diskReads: _diskReads,
    diskBytes: _diskBytes,
    cacheGeneration: _cacheGeneration,
    asyncInitStarts: _asyncInitStarts,
    asyncInitJoins: _asyncInitJoins,
    asyncGenerationWaits: _asyncGenerationWaits,
    manifestGeneratedAt: _params?.manifestGeneratedAt || null,
  };
}

// [0731 词库多段缓存 P0] 轻量清理：只清向量 LRU（真正占内存的 ~45-60MB 数据层），
// 索引层（_params/_locations/_sources fd）保持热——idle light 档消费；bin 完整性备忘天然长驻。
// 全清（下方 clearNumberbatchSubsetCache）保留原语义，供 deep 档/Unload 用。
export function clearNumberbatchSubsetVectors() {
  const freed = _vectorCache.size;
  _vectorCache.clear();
  _vectorCache = new Map();
  _cacheEvictions = 0;
  return { clearedVectors: freed, indexRetained: !!_locations };
}

export function clearNumberbatchSubsetCache() {
  const before = getNumberbatchSubsetCacheStats();
  _cacheGeneration++;
  _closeSources(_sources, "cache");
  _params = null;
  _locations = null;
  _sources = [];
  _vectorCache.clear();
  _vectorCache = new Map();
  _cacheEvictions = 0;
  _indexLoadMs = 0;
  _integrityMs = 0;
  _integrityBytes = 0;
  _diskReads = 0;
  _diskBytes = 0;
  _asyncInitStarts = 0;
  _asyncInitJoins = 0;
  _asyncGenerationWaits = 0;
  return before;
}

export default {
  getMany: getNumberbatchSubset,
  getManyAsync: getNumberbatchSubsetAsync,
  getStats: getNumberbatchSubsetCacheStats,
  clear: clearNumberbatchSubsetCache,
};
