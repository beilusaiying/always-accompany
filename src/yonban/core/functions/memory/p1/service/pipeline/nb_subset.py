"""nb_subset.py — P1 召回末段专用的本地 offset 向量后端（JS 平移: nlp/numberbatchSubset.mjs）。

契约（与 JS 逐条一致）：
  - 只按词读取固定 300d 向量，不提供全局 KNN。
  - 冷初始化校验 idx SHA-256 + bin SHA-256（bin 校验带 mtime+size 备忘：同 mtime+size 复用已验 hash，
    免 767MB 重算——JS [0731 词库多段缓存 P0] 同款语义）；通过后向量数据只按 position*1200 读取。
  - 对每个读取向量应用与 numberbatch.mjs 数值相同的 PC1 去偏（alpha/pc1 来自 numberbatch_tten_params.json）。
  - 缺参数、版本不一致、短读均响亮抛错；调用方决定是否显式退为稀疏输出。

字节布局（以 numberbatchSubset.mjs 实读代码为准，禁猜——已逐行核对）：
  - 三源 zh/en/tech（mergeOrder 固定），每源 idx=JSON string[]，bin=idx 长度 × 300 × float32（小端，
    Float32Array 原生布局）连续排列，position=词在 idx 数组中的下标，offset=position*1200。
  - 合并规则：按源序 zh→en→tech，首见词入 locations（word → sourceIndex*1_000_000 + position），重复词跳过。
  - 002 内存关切：bin 用 numpy memmap 只读映射，不整读进内存；SHA 校验为 4MB 分块流式读。

功能链：p1_node0_data_recall → get_numberbatch_subset(words, {maxCacheVectors}) → dict[word → ndarray(300,f32)]
影响范围：纯只读；进程内 LRU 向量缓存（nbCacheMaxVectors 上限）。
"""
from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np

try:
    from .resources import get_memory_lib_dir
except ImportError:
    from resources import get_memory_lib_dir

DIMS = 300
BYTES_PER_VECTOR = DIMS * 4
SOURCE_CODE_BASE = 1_000_000
DEFAULT_CACHE_MAX_VECTORS = 50_000
PARAMS_FILE_NAME = "numberbatch_tten_params.json"
SOURCE_DEFS = [
    {"name": "zh", "idx": "numberbatch_zh_idx.json", "bin": "numberbatch_zh.bin"},
    {"name": "en", "idx": "numberbatch_en_idx.json", "bin": "numberbatch_en.bin"},
    {"name": "tech", "idx": "numberbatch_tech_idx.json", "bin": "numberbatch_tech.bin"},
]

_params: dict | None = None            # {alpha, pc1(f32 ndarray), pc1_f64, vectorCount, manifestGeneratedAt}
_locations: dict[str, int] | None = None
_sources: list[dict] = []              # [{name, binPath, mmap, positions, includedCount}]
_vector_cache: OrderedDict[str, np.ndarray] = OrderedDict()
_cache_max_vectors = DEFAULT_CACHE_MAX_VECTORS
_cache_evictions = 0
_index_load_ms = 0
_integrity_ms = 0
_integrity_bytes = 0
_disk_reads = 0
_disk_bytes = 0

# bin 完整性校验结果备忘：path → {mtime_ns, size, sha256}
# 刻意不随 clear_numberbatch_subset_cache 清除（它缓存的是"文件版本的事实"非运行时数据，JS 同款）。
_bin_integrity_memo: dict[str, dict] = {}


def _sha256_bytes(buf: bytes) -> str:
    return hashlib.sha256(buf).hexdigest()


def _sha256_file(file_path: Path) -> dict:
    started = time.time()
    h = hashlib.sha256()
    nbytes = 0
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            nbytes += len(chunk)
    return {"sha256": h.hexdigest(), "bytes": nbytes, "ms": int((time.time() - started) * 1000)}


def _memoized_integrity(file_path: Path, stat) -> dict | None:
    memo = _bin_integrity_memo.get(str(file_path))
    if memo and memo["mtime_ns"] == stat.st_mtime_ns and memo["size"] == stat.st_size:
        return {"sha256": memo["sha256"], "bytes": 0, "ms": 0, "memoized": True}
    return None


def _remember_integrity(file_path: Path, stat, sha256: str) -> None:
    _bin_integrity_memo[str(file_path)] = {
        "mtime_ns": stat.st_mtime_ns,
        "size": stat.st_size,
        "sha256": sha256,
    }


def _validate_params(params: dict) -> None:
    if params.get("schema") != "beilu-numberbatch-tten-params-v1":
        raise ValueError(f"unsupported Numberbatch subset params schema: {params.get('schema') or 'missing'}")
    if params.get("dims") != DIMS or params.get("bytesPerVector") != BYTES_PER_VECTOR:
        raise ValueError("Numberbatch subset params dimension mismatch")
    alpha = params.get("alpha")
    pc1 = params.get("pc1")
    if not isinstance(alpha, (int, float)) or not isinstance(pc1, list) or len(pc1) != DIMS:
        raise ValueError("Numberbatch subset params missing alpha/pc1")
    if params.get("mergeOrder") != [s["name"] for s in SOURCE_DEFS]:
        raise ValueError("Numberbatch subset merge order mismatch")


def _load_index() -> None:
    global _params, _locations, _sources, _index_load_ms, _integrity_ms, _integrity_bytes
    if _locations is not None:
        return
    started = time.time()
    memory_dir = get_memory_lib_dir()
    params_path = memory_dir / PARAMS_FILE_NAME
    params = json.loads(params_path.read_text(encoding="utf-8"))
    _validate_params(params)

    locations: dict[str, int] = {}
    source_rows: list[dict] = []
    integrity_ms = 0
    integrity_bytes = 0
    for source_index, sdef in enumerate(SOURCE_DEFS):
        manifest = next((s for s in (params.get("sources") or []) if s.get("name") == sdef["name"]), None)
        if not manifest or manifest.get("idx") != sdef["idx"] or manifest.get("bin") != sdef["bin"]:
            raise ValueError(f"Numberbatch subset manifest missing source={sdef['name']}")
        idx_path = memory_dir / sdef["idx"]
        bin_path = memory_dir / sdef["bin"]
        idx_buffer = idx_path.read_bytes()
        words = json.loads(idx_buffer.decode("utf-8"))
        if not isinstance(words, list) or len(words) != manifest["idxCount"]:
            raise ValueError(f"Numberbatch subset idx count mismatch: {sdef['idx']}")
        if _sha256_bytes(idx_buffer) != manifest["idxSha256"]:
            raise ValueError(f"Numberbatch subset idx hash mismatch: {sdef['idx']}")
        stat = bin_path.stat()
        if stat.st_size != manifest["binBytes"] or stat.st_size != len(words) * BYTES_PER_VECTOR:
            raise ValueError(f"Numberbatch subset bin size mismatch: {sdef['bin']}")
        integrity = _memoized_integrity(bin_path, stat)
        if not integrity:
            integrity = _sha256_file(bin_path)
            _remember_integrity(bin_path, stat, integrity["sha256"])
        integrity_bytes += integrity["bytes"]
        integrity_ms += integrity["ms"]
        if integrity["sha256"] != manifest["binSha256"]:
            raise ValueError(f"Numberbatch subset bin hash mismatch: {sdef['bin']}")
        if len(words) >= SOURCE_CODE_BASE:
            raise ValueError(f"Numberbatch subset source exceeds position encoding: {sdef['name']}")
        included_count = 0
        base = source_index * SOURCE_CODE_BASE
        for position, word in enumerate(words):
            if word in locations:
                continue
            locations[word] = base + position
            included_count += 1
        if included_count != manifest["includedCount"]:
            raise ValueError(f"Numberbatch subset merge count mismatch: {sdef['name']}")
        source_rows.append({
            "name": sdef["name"],
            "binPath": bin_path,
            "positions": len(words),
            "includedCount": included_count,
        })
    if len(locations) != params["vectorCount"]:
        raise ValueError(
            f"Numberbatch subset total count mismatch: {len(locations)} != {params['vectorCount']}"
        )
    sources = []
    for row in source_rows:
        # memmap 只读映射(002 内存关切: 767MB bin 不整读进内存, 按 offset 惰性取页)
        mm = np.memmap(row["binPath"], dtype="<f4", mode="r")
        sources.append({**row, "mmap": mm})

    pc1_f32 = np.asarray(params["pc1"], dtype=np.float32)  # JS: Float32Array.from(params.pc1) 同款精度
    _params = {
        "alpha": float(params["alpha"]),
        "pc1": pc1_f32,
        "pc1_f64": pc1_f32.astype(np.float64),
        "vectorCount": params["vectorCount"],
        "manifestGeneratedAt": params.get("generatedAt"),
    }
    _locations = locations
    _sources = sources
    _integrity_ms = integrity_ms
    _integrity_bytes = integrity_bytes
    _index_load_ms = int((time.time() - started) * 1000)


def _resolve_cache_max_vectors(value) -> int:
    try:
        configured = float(value)
    except (TypeError, ValueError):
        return DEFAULT_CACHE_MAX_VECTORS
    if not np.isfinite(configured):
        return DEFAULT_CACHE_MAX_VECTORS
    return max(0, min(SOURCE_CODE_BASE - 1, int(configured)))


def _trim_vector_cache(limit: int) -> None:
    global _cache_evictions
    while len(_vector_cache) > limit:
        _vector_cache.popitem(last=False)
        _cache_evictions += 1


def _get_vector(word: str) -> np.ndarray | None:
    global _disk_reads, _disk_bytes
    cached = _vector_cache.get(word)
    if cached is not None:
        _vector_cache.move_to_end(word)
        return cached
    code = _locations.get(word)
    if code is None:
        return None
    source_index = code // SOURCE_CODE_BASE
    position = code - source_index * SOURCE_CODE_BASE
    if source_index >= len(_sources):
        raise ValueError(f"Numberbatch subset invalid source code for word={word}")
    source = _sources[source_index]
    raw = np.array(source["mmap"][position * DIMS:(position + 1) * DIMS], dtype=np.float32, copy=True)
    if raw.shape[0] != DIMS:
        raise ValueError(f"Numberbatch subset short read: source={source['name']} position={position}")
    _disk_reads += 1
    _disk_bytes += BYTES_PER_VECTOR

    # PC1 去偏(JS 逐维双精度累计 projection, 再 raw - alpha*projection*pc1 存回 f32)
    raw64 = raw.astype(np.float64)
    projection = float(raw64 @ _params["pc1_f64"])
    vector = (raw64 - _params["alpha"] * projection * _params["pc1_f64"]).astype(np.float32)
    if _cache_max_vectors > 0:
        _vector_cache[word] = vector
        _trim_vector_cache(_cache_max_vectors)
    return vector


def _get_many_loaded(words, options=None) -> dict[str, np.ndarray]:
    global _cache_max_vectors
    _cache_max_vectors = _resolve_cache_max_vectors((options or {}).get("maxCacheVectors"))
    _trim_vector_cache(_cache_max_vectors)
    result: dict[str, np.ndarray] = {}
    uniq = list(dict.fromkeys(words or []))  # Set 去重保序
    for word in uniq:
        if not word:
            continue
        vector = _get_vector(word)
        if vector is not None:
            result[word] = vector
    return result


def get_numberbatch_subset(words, options=None) -> dict[str, np.ndarray]:
    _load_index()
    return _get_many_loaded(words, options)


def get_numberbatch_subset_cache_stats() -> dict:
    return {
        "indexLoaded": _locations is not None,
        "initializing": False,  # Python 同步实现无异步初始化态(JS async 路径在 Python 收敛为同步)
        "indexTerms": len(_locations) if _locations else 0,
        "paramsLoaded": _params is not None,
        "cachedVectors": len(_vector_cache),
        "cacheMaxVectors": _cache_max_vectors,
        "cacheEvictions": _cache_evictions,
        "openFiles": len(_sources),
        "indexLoadMs": _index_load_ms,
        "integrityMs": _integrity_ms,
        "integrityBytes": _integrity_bytes,
        "diskReads": _disk_reads,
        "diskBytes": _disk_bytes,
        "manifestGeneratedAt": _params["manifestGeneratedAt"] if _params else None,
    }


def clear_numberbatch_subset_vectors() -> dict:
    """轻量清理：只清向量 LRU（数据层），索引层/mmap 保持热；完整性备忘天然长驻。"""
    global _cache_evictions
    freed = len(_vector_cache)
    _vector_cache.clear()
    _cache_evictions = 0
    return {"clearedVectors": freed, "indexRetained": _locations is not None}


def clear_numberbatch_subset_cache() -> dict:
    """全清（deep 档/Unload 用）：释放索引与 memmap 引用；完整性备忘保留（文件版本事实）。"""
    global _params, _locations, _sources, _cache_evictions
    global _index_load_ms, _integrity_ms, _integrity_bytes, _disk_reads, _disk_bytes
    before = get_numberbatch_subset_cache_stats()
    _params = None
    _locations = None
    _sources = []
    _vector_cache.clear()
    _cache_evictions = 0
    _index_load_ms = 0
    _integrity_ms = 0
    _integrity_bytes = 0
    _disk_reads = 0
    _disk_bytes = 0
    return before
