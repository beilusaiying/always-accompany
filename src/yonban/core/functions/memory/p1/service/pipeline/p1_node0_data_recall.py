"""p1_node0_data_recall.py — 节点0-data: data 三层记忆候选召回（JS 平移: p1/p1_node0_data_recall.mjs）。

功能链：p1_recall.recall_v2 → recall_node0_data(mem_dirs, input_words, swow_pool, ...) → dataAnchors
        与 recall_node0（上下文锚点）并行，anchors = ctxAnchors ∪ dataAnchors。
顺序：条目拆分/分词 → 倒排定位 → BM25 稀疏搜索 → 层权融合/截断 → NB300 候选复核 → 锚点。
NB300 不参与全库扫描，也不负责候选生成；没有稀疏候选时不会加载向量库。
关联链：
  ← p1_recall.py（recall_v2 内调用，dataRecall 门控）
  → resources.run_step1_extract（分词，与 node0 同口径）/ resources.get_bcc_freq（BCC 软降权）
  → p1_node8_10_blq.calc_blq（BLQ 分项白盒）/ nb_subset.get_numberbatch_subset（NB300 候选复核）
影响范围：纯只读 data/users/<u>/chars/<c>/memory/（角色级+_global），mtime 签名缓存，不写任何文件。
红线：召回不主导——dataAnchor strength 上限 STRENGTH_CAP(0.5) 低于 ctx 锚点上限(0.7)。
平移保真（0731 定档值）：
    BM25 k1=1.2/b=0.75 · minHitsFor configured 优先(恒2, 钳[2,8], 禁1)+句长分级 fallback ·
    LAYER_W hot1.0/warm0.85/cold0.7 可经 opts.layerWeights 覆盖 · DF-idf 连续降权+BCC(gate 150000, ×0.05) ·
    recency 0.995 · entryTopK 20 · termTopK 6 · sparseTopK 100 · recordTopK 5 · snippetMaxChars 240 ·
    injectMaxChars 0=不限(关联度降序累计, 首条保底) · recentDataTopK 默认0(002 拍板 5→0) ·
    _modeSkips 模式隔离 · collapseSameFileKeywordSet · indexCacheMax 8(LRU) · trace_ 字段名与 JS 逐字一致。
[JS 兼容平移记录]（疑似 bug/quirk 原样保留，只记录不修）：
    ① _splitEntries JSON 解析失败的按行 fallback 只带 {text,display} —— locator 在 JS 模板串里变
       字符串 "undefined" 进 stableId，Python 用同字面量对齐哈希语义。
    ② timestamp/weight 等 undefined 字段在 JS JSON 序列化时被丢键，Python 输出 null——消费方
       （前端 meta 渲染）对两者同判空，已知无消费差异。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

try:
    from .p1_whitebox import trace
    from .resources import run_step1_extract, get_bcc_freq
    from .p1_node8_10_blq import calc_blq
    from .nb_subset import get_numberbatch_subset
except ImportError:
    from p1_whitebox import trace
    from resources import run_step1_extract, get_bcc_freq
    from p1_node8_10_blq import calc_blq
    from nb_subset import get_numberbatch_subset

# ── 旧调用兼容默认值；生产调用使用插件传入的请求级配置（env 名与 JS 同款）──
def p1_data_recall_on() -> bool:
    return os.environ.get("P1_DATA_RECALL") == "on"  # 默认 off（0603 §2.6 灰度）


MAX_FILE = float(os.environ.get("P1_DATA_MAX_FILE") or 500 * 1024)
ANCHOR_MAX = int(float(os.environ.get("P1_DATA_ANCHOR_MAX") or 8))
STRENGTH_BASE = float(os.environ.get("P1_DATA_STRENGTH_BASE") or 0.2)
STRENGTH_STEP = float(os.environ.get("P1_DATA_STRENGTH_STEP") or 0.1)
STRENGTH_CAP = float(os.environ.get("P1_DATA_STRENGTH_CAP") or 0.5)  # < ctx 锚点最高 0.7 —— 召回不主导
# 层权（结构序数软权重；加性累计=多对一投票精神，空间相加不相乘）
LAYER_W = {"hot": 1.0, "warm": 0.85, "cold": 0.7}
# BCC 软降权(铁律#48 降权不硬删)
BCC_DEMOTE_GATE = float(os.environ.get("P1_DATA_BCC_GATE") or 150000)
BCC_DEMOTE = float(os.environ.get("P1_DATA_BCC_DEMOTE") or 0.05)


def p1_data_vector_on() -> bool:
    return os.environ.get("P1_DATA_VECTOR") == "on"


VEC_FILE_WORD_CAP = int(float(os.environ.get("P1_DATA_VEC_WORD_CAP") or 200))
DEFAULT_INDEX_CACHE_MAX = 8

# ── reader：递归收 memDirs 下 json/jsonl/md → per-file {rel, layer, text}（mtime 签名缓存范式）──
_SKIP_FILES = {"tasks.json", "promoted_experience.json"}
_ALL_MODES = ["chat", "code", "work"]
_FILE_EXT_RE = re.compile(r"\.(?:json|jsonl|md)$", re.I)


def _get_mode_private_paths(mode):
    """storage.mjs getModePrivatePaths 平移（单一权威语义；`<mode>_ctx` 维度已退役 20260726）。"""
    if mode == "code":
        return {"tableFile": "code_tables.json", "dirs": ["code"]}
    if mode == "work":
        return {"tableFile": "work_tables.json", "dirs": ["work"]}
    return {"tableFile": "tables.json", "dirs": []}


def _mode_skips(mode):
    m = "code" if mode == "ide" else (mode or "chat")
    skip_dirs: set[str] = set()
    skip_files: set[str] = set()
    for om in _ALL_MODES:
        if om == m:
            continue
        p = _get_mode_private_paths(om)
        for d in p["dirs"]:
            skip_dirs.add(d)
        if p["tableFile"]:
            skip_files.add(p["tableFile"])
    return {"skipDirs": skip_dirs, "skipFiles": skip_files, "includeMarkdown": True}


def _collect(dir_path, rel_base, out, skips, root_index):
    try:
        ents = list(os.scandir(dir_path))
    except OSError as error:
        print(f"[p1_node0_data_recall] memory directory unreadable: {dir_path} {error}", file=sys.stderr)
        return
    for e in ents:
        name = e.name
        if name.startswith("_") or name == "vocab":
            continue
        is_dir = e.is_dir()
        if is_dir and not rel_base and skips and name in skips["skipDirs"]:
            continue  # 首层段判(同 memoryRecall _segs[0] 口径)
        full = os.path.join(dir_path, name)
        rel = rel_base + "/" + name if rel_base else name
        if is_dir:
            _collect(full, rel, out, skips, root_index)
        elif (
            _FILE_EXT_RE.search(name)
            and (skips.get("includeMarkdown") is not False or not name.lower().endswith(".md"))
            and name not in _SKIP_FILES
            and not (skips and name in skips["skipFiles"])
        ):
            out.append({
                "full": full,
                "rel": rel,
                "sourceRel": f"{root_index}:{rel}",
                "format": os.path.splitext(name)[1][1:].lower(),
            })


def _layer_of(rel):
    head = rel.split("/")[0]
    return "hot" if head == "hot" else ("cold" if head == "cold" else "warm")  # 顶层散文件记 warm 中性


_cache: OrderedDict[str, dict] = OrderedDict()  # key(dirs+mode+md) → store
_cache_max_indexes = DEFAULT_INDEX_CACHE_MAX
_cache_evictions = 0


def _resolve_index_cache_max(value):
    try:
        configured = float(value)
    except (TypeError, ValueError):
        return DEFAULT_INDEX_CACHE_MAX
    if not math.isfinite(configured):
        return DEFAULT_INDEX_CACHE_MAX
    return max(0, min(64, int(configured)))


def _trim_index_cache(limit):
    global _cache_evictions
    while len(_cache) > limit:
        _cache.popitem(last=False)
        _cache_evictions += 1


# ── JS 值语义辅助 ──
_UNDEF = object()  # JS undefined 哨兵（与 JSON null=None 区分）


def _js_number(value):
    """Number() 语义子集：null→0 / undefined→NaN / bool→1|0 / str→trim(空串→0) / 失败→NaN。"""
    if value is _UNDEF:
        return math.nan
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return math.nan
    return math.nan


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _opt_num(opts, key):
    """请求级配置读数：Python 侧 dict 值 None=「键未配置」=JS undefined → NaN → 走 fallback。
    （JS 生产链传 undefined 而非 null；若按 Number(null)=0 处理会把 sparseTopK/termTopK 等
    钳成 1 —— 0731 拉线实测踩坑，根因层修在此单点，不在各消费点打补丁。）"""
    v = opts.get(key)
    return _js_number(_UNDEF if v is None else v)


_DATE_ONLY_RE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")


def _date_parse_ms(value):
    """Date.parse 语义近似：ISO 8601（date-only=UTC / datetime 无时区=本地）+ RFC2822 兜底；失败→None。"""
    s = str(value).strip()
    if not s:
        return None
    try:
        if _DATE_ONLY_RE.match(s):
            parts = s.split("-")
            y = int(parts[0])
            mo = int(parts[1]) if len(parts) > 1 else 1
            d = int(parts[2]) if len(parts) > 2 else 1
            dt = datetime(y, mo, d, tzinfo=timezone.utc)
            return dt.timestamp() * 1000
        iso = s[:-1] + "+00:00" if s.endswith(("Z", "z")) else s
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.astimezone()  # JS: 无时区 datetime = 本地时间
        return dt.timestamp() * 1000
    except (ValueError, OverflowError, OSError):
        pass
    try:
        from email.utils import parsedate_to_datetime

        dt = parsedate_to_datetime(s)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.astimezone()
            return dt.timestamp() * 1000
    except (TypeError, ValueError):
        pass
    return None


def _to_iso(ms):
    """Date#toISOString 平移：UTC，毫秒 3 位 + Z。"""
    total_ms = int(ms)
    sec, msec = divmod(total_ms, 1000)
    dt = datetime.fromtimestamp(sec, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{msec:03d}Z"


def _json_stringify(obj):
    """JSON.stringify 近似：无空格分隔、非 ASCII 原样。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)


def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", "surrogatepass")).hexdigest()


def _fx(x, n):
    return float(f"{float(x):.{n}f}")


def _bounded_int(value, fallback, lo, hi):
    numeric = _js_number(value if value is not None else _UNDEF)
    picked = numeric if _finite(numeric) else fallback
    return max(lo, min(hi, int(picked)))


def _record_view(record, snippet_max_chars):
    limit = _bounded_int(snippet_max_chars, 240, 40, 2000)
    content = str(record.get("content") or "")
    return {
        "recordId": record["recordId"],
        "layer": record["layer"],
        "sourceRel": record["sourceRel"],
        "timestamp": record["timestamp"],
        "timeSource": record["timeSource"],
        "content": content[:limit] if len(content) > limit else content,
        "contentLength": len(content),
        "contentHash": record["contentHash"],
        "weight": record["weight"],
    }


# ── 条目级拆分(兼容 JSON / JSONL / Markdown；T5d 逐分支平移) ──
_TIME_FIELDS = ["timestamp", "date", "completed_at", "archived_at", "created_at"]
_CRLF_RE = re.compile(r"\r\n?")
_MD_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*$")


def _time_from_object(obj):
    if not isinstance(obj, dict):
        return {"timestamp": None, "timeSource": None}
    for field in _TIME_FIELDS:
        value = obj.get(field, _UNDEF)
        if value is _UNDEF or value is None or value == "":
            continue
        parsed = _date_parse_ms(value)
        if parsed is not None and math.isfinite(parsed):
            return {"timestamp": _to_iso(parsed), "timeSource": field}
    return {"timestamp": None, "timeSource": None}


def _normalize_record_content(value):
    return _CRLF_RE.sub("\n", str(value or "")).replace("\u0000", "").strip()


def _js_str_term(v):
    """String(value||"").trim()：JS falsy(None/""/0/False)→""；注意 []/{} 在 JS 为 truthy（罕见，str() 兜底）。"""
    if v is None or v == "" or v == 0 or v is False:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, bool):
        return "true"
    return str(v).strip()


def _split_markdown(text):
    entries = []
    lines = _CRLF_RE.sub("\n", str(text or "")).split("\n")
    heading = ""
    paragraph: list[str] = []
    state = {"paragraphIndex": 0}

    def flush():
        nonlocal paragraph
        body = "\n".join(paragraph).strip()
        paragraph = []
        if not body:
            return
        display = _normalize_record_content(f"{heading}\n{body}" if heading else body)
        if len(display) >= 5:
            entries.append({
                "display": display,
                "searchText": display,
                "locator": f"md:{state['paragraphIndex']}",
                "explicitRecordId": None,
                "timestamp": None,
                "timeSource": None,
                "weight": None,
                "heat": None,
                "metadataTerms": [],
            })
            state["paragraphIndex"] += 1

    for line in lines:
        match = _MD_HEADING_RE.match(line)
        if match:
            flush()
            heading = match.group(1).strip()
            continue
        if not line.strip():
            flush()
            continue
        paragraph.append(line)
    flush()
    return entries


def _split_entries(text, fmt="json"):
    if fmt == "md":
        return _split_markdown(text)
    entries = []
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        data = None
    state = {"locatorIndex": 0}

    def push_obj(obj, locator=None):
        t = obj if isinstance(obj, str) else _json_stringify(obj)
        if not t or len(t) < 5:
            return
        display = t
        if isinstance(obj, dict):
            # 主内容字段: 优先 content/event/thing/summary/task/mes（JS || 真值链）
            main = None
            for k in ("content", "event", "thing", "summary", "task", "mes"):
                v = obj.get(k)
                if v:  # JS truthy
                    main = v
                    break
            if main is not None:
                display = str(main)
        display = _normalize_record_content(display)
        if len(display) < 5:
            return
        tf = _time_from_object(obj if isinstance(obj, dict) else None)
        # numericWeight = Number(obj?.weight ?? obj?.importance)（?? 链语义，见 _js_number 注释）
        if isinstance(obj, dict):
            if "weight" in obj and obj["weight"] is not None:
                raw_weight = obj["weight"]
            elif "importance" in obj:
                raw_weight = obj["importance"]  # 可能为 None(JSON null → Number(null)=0)
            else:
                raw_weight = _UNDEF
            raw_heat = obj.get("last_triggered", _UNDEF)
            metadata_terms = []
            for key in ("keywords", "keyword_nodes", "tags"):
                v = obj.get(key)
                if isinstance(v, list):
                    metadata_terms.extend(v)
            metadata_terms = [t2 for t2 in (_js_str_term(v) for v in metadata_terms) if t2]
            explicit_record_id = obj.get("recordId") or obj.get("record_id") or None
        else:
            raw_weight = _UNDEF
            raw_heat = _UNDEF
            metadata_terms = []
            explicit_record_id = None
        numeric_weight = _js_number(raw_weight)
        heat_value = _js_number(raw_heat)
        if locator is None:
            locator = f"{fmt}:{state['locatorIndex']}"
            state["locatorIndex"] += 1
        entries.append({
            "display": display,
            "searchText": " ".join([display, *metadata_terms]),
            "locator": locator,
            "explicitRecordId": explicit_record_id,
            "timestamp": tf["timestamp"],
            "timeSource": tf["timeSource"],
            "weight": numeric_weight if _finite(numeric_weight) else None,
            "heat": heat_value if _finite(heat_value) else None,
            "metadataTerms": metadata_terms,
        })

    if fmt == "jsonl":
        for line_index, line in enumerate(str(text or "").split("\n")):
            trimmed = line.strip()
            if len(trimmed) < 5:
                continue
            try:
                push_obj(json.loads(trimmed), f"jsonl:{line_index}")
            except (ValueError, TypeError):
                push_obj(trimmed, f"jsonl:{line_index}")
    elif isinstance(data, (dict, list)):
        if isinstance(data, dict) and isinstance(data.get("entries"), list):
            for e in data["entries"]:
                push_obj(e)
        elif isinstance(data, dict) and isinstance(data.get("messages"), list):
            for m in data["messages"]:
                push_obj(m)  # build_memory_data 构造格式
        elif isinstance(data, dict) and isinstance(data.get("tables"), list):
            for t in data["tables"]:
                rows = t.get("rows") or [] if isinstance(t, dict) else []
                for row in rows:
                    push_obj(" ".join(str(x) for x in row) if isinstance(row, list) else row)
        elif isinstance(data, list):
            for e in data:
                push_obj(e)
        elif isinstance(data.get("summary"), str):
            push_obj({"summary": data["summary"]})
        else:
            any_arr = False
            for v in data.values():
                if isinstance(v, list):
                    for e in v:
                        push_obj(e)
                    any_arr = True
            if not any_arr:
                push_obj(data)
    else:
        # JSON parse 失败 → 按行拆(memoryRecall 同口径)。[JS 兼容记录①] 只带 {text,display}，
        # locator/其余字段缺席——stableId 里 locator 用字面量 "undefined" 对齐 JS 模板串行为。
        for line in str(text or "").split("\n"):
            s = line.strip()
            if len(s) >= 5:
                entries.append({"text": s, "display": s})
    return entries


def _utf16_key(s: str):
    """JS 默认 Array#sort 比较 = UTF-16 码元序 → utf-16-be 字节序等价。"""
    return s.encode("utf-16-be", "surrogatepass")


def _build_sparse_index(entries):
    records = []
    postings: dict[str, list[int]] = {}
    total_terms = 0
    for ent in entries:
        for sub in _split_entries(ent["text"], ent["format"]):
            raw_words = run_step1_extract(sub.get("searchText") or sub.get("display") or "").get("words") or []
            searchable_words = [w for w in raw_words if w and len(w) >= 2]
            term_freq: dict[str, int] = {}
            for word in searchable_words:
                term_freq[word] = term_freq.get(word, 0) + 1
            tokens = list(term_freq.keys())
            if not tokens:
                continue
            rid = len(records)
            display = sub.get("display") or ""
            content_hash = _sha256_hex(display)
            locator = sub.get("locator")
            if locator is None:
                locator = "undefined"  # [JS 兼容记录①] 模板串 undefined
            stable_id = _sha256_hex(f"{ent['sourceRel']}\u0000{locator}\u0000{content_hash}")[:24]
            explicit = sub.get("explicitRecordId")
            metadata_terms = sub.get("metadataTerms")
            if metadata_terms:
                uniq = sorted({t.lower() for t in metadata_terms}, key=_utf16_key)
                metadata_signature = _sha256_hex("\u0000".join(uniq))[:20]
            else:
                metadata_signature = None
            record = {
                "id": rid,
                "recordId": str(explicit)[:120] if explicit else stable_id,
                "rel": ent["sourceRel"],
                "sourceRel": ent["sourceRel"],
                "layer": ent["layer"],
                "content": display,
                "contentHash": content_hash,
                "timestamp": sub.get("timestamp"),
                "timeSource": sub.get("timeSource"),
                "weight": sub.get("weight"),
                "heat": sub.get("heat"),
                "metadataSignature": metadata_signature,
                "tokens": tokens,
                "tokenSet": set(tokens),
                "termFreq": term_freq,
                "length": len(searchable_words),
            }
            records.append(record)
            total_terms += record["length"]
            for token in tokens:
                postings.setdefault(token, []).append(rid)
        ent["text"] = None  # 索引已持有条目 token，不保留整文件字符串副本
    return {
        "records": records,
        "postings": postings,
        "avgDocLength": total_terms / len(records) if records else 0,
    }


def _read_data_store(mem_dirs, mode, cache_max_indexes, include_markdown=True):
    global _cache_max_indexes
    _cache_max_indexes = _resolve_index_cache_max(cache_max_indexes)
    _trim_index_cache(_cache_max_indexes)
    dirs = [d for d in (mem_dirs if isinstance(mem_dirs, list) else [mem_dirs]) if d]
    if not dirs:
        return {
            "store": {"entries": [], "records": [], "postings": {}, "avgDocLength": 0, "buildMs": 0},
            "cacheHit": False,
        }
    skips = _mode_skips(mode)
    skips["includeMarkdown"] = include_markdown is not False
    files: list[dict] = []
    for root_index, d in enumerate(dirs):
        _collect(d, "", files, skips, root_index)
    files.sort(key=lambda f: (f["full"].lower(), f["full"]))  # localeCompare 近似(大小写不敏感优先)
    sig_parts = []
    for f in files:
        try:
            stat = os.stat(f["full"])
            mtime_ms = stat.st_mtime_ns / 1e6
            size = stat.st_size
        except OSError as error:
            print(f"[p1_node0_data_recall] memory file stat failed: {f['full']} {error}", file=sys.stderr)
            mtime_ms = 0
            size = 0
        sig_parts.append(f"{f['full']}:{mtime_ms}:{size}|")
    sig = "".join(sig_parts)
    key = ("\u0000".join(dirs)
           + "|" + ("code" if mode == "ide" else (mode or "chat"))
           + "|md:" + ("on" if include_markdown is not False else "off"))
    cached = _cache.get(key)
    if cached is not None and cached["sig"] == sig:
        _cache.move_to_end(key)
        return {"store": cached, "cacheHit": True}
    build_started = time.time()
    entries = []
    for f in files:
        try:
            if os.stat(f["full"]).st_size > MAX_FILE:
                continue
            with open(f["full"], "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            entries.append({
                "rel": f["rel"],
                "sourceRel": f["sourceRel"],
                "layer": _layer_of(f["rel"]),
                "format": f["format"],
                "text": text,
            })
        except OSError as error:
            print(f"[p1_node0_data_recall] memory file read failed: {f['full']} {error}", file=sys.stderr)
    idx = _build_sparse_index(entries)
    store = {
        "sig": sig,
        "entries": entries,
        "records": idx["records"],
        "postings": idx["postings"],
        "avgDocLength": idx["avgDocLength"],
        "buildMs": int((time.time() - build_started) * 1000),
    }
    if _cache_max_indexes > 0:
        _cache.pop(key, None)
        _cache[key] = store
        _trim_index_cache(_cache_max_indexes)
    return {"store": store, "cacheHit": False}


def get_data_recall_cache_stats():
    files = records = posting_terms = posting_refs = 0
    for value in _cache.values():
        files += len(value.get("entries") or [])
        records += len(value.get("records") or [])
        postings = value.get("postings") or {}
        posting_terms += len(postings)
        for ids in postings.values():
            posting_refs += len(ids)
    return {
        "keys": len(_cache),
        "files": files,
        "records": records,
        "postingTerms": posting_terms,
        "postingRefs": posting_refs,
        "cacheMaxIndexes": _cache_max_indexes,
        "cacheEvictions": _cache_evictions,
    }


def clear_data_recall_cache():
    global _cache_evictions
    before = get_data_recall_cache_stats()
    _cache.clear()
    _cache_evictions = 0
    return before


def prepare_data_recall(mem_dirs, opts=None):
    """为同一次 recall 请求准备唯一 data 句柄。文件发现/解析/倒排/最近 data 全从这一份 store 派生。"""
    opts = opts or {}
    started = time.time()
    enabled = opts["dataRecall"] if isinstance(opts.get("dataRecall"), bool) else p1_data_recall_on()
    if not enabled:
        return {
            "store": None,
            "cacheHit": False,
            "recentRecords": [],
            "trace_": {
                "enabled": False,
                "backend": "memory-inverted",
                "reason": "disabled",
                "indexFiles": 0,
                "indexRecords": 0,
                "totalMs": int((time.time() - started) * 1000),
            },
        }
    rs = _read_data_store(mem_dirs, opts.get("mode"), opts.get("indexCacheMax"), opts.get("includeMarkdown", True))
    store, cache_hit = rs["store"], rs["cacheHit"]
    recent_top_k = _bounded_int(opts.get("recentDataTopK"), 0, 0, 50)  # [0731 002拍板 5→0]
    dated = [r for r in store["records"] if r["timestamp"] and _date_parse_ms(r["timestamp"]) is not None]
    dated.sort(key=lambda r: -_date_parse_ms(r["timestamp"]))
    recent_records = [_record_view(r, opts.get("snippetMaxChars")) for r in dated[:recent_top_k]]
    return {
        "store": store,
        "cacheHit": cache_hit,
        "recentRecords": recent_records,
        "trace_": {
            "enabled": True,
            "backend": "memory-inverted",
            "reason": "ready" if store["records"] else "empty-index",
            "indexFiles": len(store["entries"]),
            "indexRecords": len(store["records"]),
            "postingTerms": len(store["postings"]),
            "indexCacheHit": cache_hit,
            "recentRecords": [{
                "recordId": r["recordId"],
                "layer": r["layer"],
                "sourceRel": r["sourceRel"],
                "timestamp": r["timestamp"],
                "timeSource": r["timeSource"],
                "contentLength": r["contentLength"],
                "contentHash": r["contentHash"],
            } for r in recent_records],
            "totalMs": int((time.time() - started) * 1000),
        },
    }


# ── 分级门槛 minHitsFor（002 规格定案 经验#16，单源，139号设计）──
#   [0731 002确认] 生产经插件恒传 candidateMinHits=2（configured 优先），恒2为演进默认；
#   分级逻辑保留为直连调用(未传配置)的 fallback。禁出现 1。
def min_hits_for(input_text_len, layer, configured_min_hits=None):
    requested = _js_number(configured_min_hits if configured_min_hits is not None else _UNDEF)
    if _finite(requested):
        return max(2, min(8, int(requested)))
    if layer != "hot":
        return 4  # 归档类型（warm/cold 层）→ 固定 4
    if input_text_len <= 15:
        return 2
    if input_text_len <= 40:
        return 3
    return 4


def _cosine(a, b):
    a64 = np.asarray(a, dtype=np.float64)[:300]
    b64 = np.asarray(b, dtype=np.float64)[:300]
    n = math.sqrt(float(a64 @ a64)) * math.sqrt(float(b64 @ b64))
    return float(a64 @ b64) / n if n > 0 else 0.0


def _centroid_from_words(words, nb_pool):
    if not nb_pool:
        return None
    vecs = []
    for word in words:
        vector = nb_pool.get(word)
        if vector is not None:
            vecs.append(vector)
        if len(vecs) >= VEC_FILE_WORD_CAP:
            break
    if not vecs:
        return None
    c = np.zeros(300, dtype=np.float32)  # JS Float32Array 累加语义
    for v in vecs:
        c += np.asarray(v, dtype=np.float32)
    c /= np.float32(len(vecs))
    return c


def _record_centroid(record, nb_pool, request_centroids):
    if record["id"] in request_centroids:
        return request_centroids[record["id"]]
    centroid = _centroid_from_words(record["tokens"], nb_pool)
    request_centroids[record["id"]] = centroid
    return centroid


def _locate_candidates(store, query_words):
    """倒排 posting 是"定位"边界；召回算法不依赖具体存储。"""
    located: dict[int, dict] = {}
    for query_word in query_words:
        ids = store["postings"].get(query_word)
        if not ids:
            continue
        for rid in ids:
            state = located.get(rid)
            if state is None:
                state = {"record": store["records"][rid], "hits": []}  # hits 保序去重（JS Set 语义）
                located[rid] = state
            if query_word not in state["hits"]:
                state["hits"].append(query_word)
    return located


def _bm25_idf(document_count, document_frequency):
    return math.log(1 + (document_count - document_frequency + 0.5) / (document_frequency + 0.5))


def _bm25_score(store, record, hits, k1, b):
    document_count = len(store["records"])
    avg_length = store["avgDocLength"] or 1
    score = 0.0
    for term in hits:
        tf = record["termFreq"].get(term, 0)
        df = len(store["postings"].get(term) or [])
        if tf <= 0 or df <= 0:
            continue
        denominator = tf + k1 * (1 - b + b * (record["length"] / avg_length))
        score += _bm25_idf(document_count, df) * ((tf * (k1 + 1)) / denominator)
    return score


# ════════════════════════════════════════════════════════════════════
# recall_node0_data — 拆分 → 倒排定位 → BM25 → 候选截断 → NB300复核 → 锚点
# ════════════════════════════════════════════════════════════════════
def recall_node0_data(mem_dirs, input_words, swow_pool, is_noise, seen_nodes, opts=None,
                      subset_loader=get_numberbatch_subset):
    started = time.time()
    opts = opts or {}
    _noise = is_noise if callable(is_noise) else (lambda w: False)
    _seen = seen_nodes if isinstance(seen_nodes, set) else set()
    # 已知实体排除: 用户名/角色名=手上已知的信息, 精确排除, 不猜频率
    _exclude = {w for w in (opts.get("excludeWords") or []) if w}
    _mode = opts.get("mode")
    data_recall_on = opts["dataRecall"] if isinstance(opts.get("dataRecall"), bool) else p1_data_recall_on()

    def _ms():
        return int((time.time() - started) * 1000)

    def empty(reason, extra=None):
        trace_e = {
            "enabled": data_recall_on,
            "backend": "memory-inverted",
            "scanned": 0,
            "hitFiles": 0,
            "layerDist": {},
            "anchors": [],
            "reason": reason,
            "totalMs": _ms(),
        }
        if extra:
            trace_e.update(extra)
        return {
            "dataAnchors": [],
            "recalledRecords": [],
            "trace_": trace_e,
            "inputCentroid": opts.get("inputCentroid"),
            "nbPool": opts.get("nbPool"),
        }

    if not data_recall_on:
        return empty("disabled")

    prepared = opts.get("prepared") or prepare_data_recall(mem_dirs, {
        "dataRecall": data_recall_on,
        "mode": _mode,
        "indexCacheMax": opts.get("indexCacheMax"),
        "recentDataTopK": opts.get("recentDataTopK"),
        "snippetMaxChars": opts.get("snippetMaxChars"),
        "includeMarkdown": opts.get("includeMarkdown", True),
    })
    if not prepared or not prepared.get("store"):
        return empty((prepared or {}).get("trace_", {}).get("reason") or "empty-index",
                     {"prepared": (prepared or {}).get("trace_")})
    store = prepared["store"]
    cache_hit = prepared["cacheHit"]
    index_ready_ms = _ms()
    if not store["records"]:
        return empty("empty-index", {
            "indexFiles": len(store["entries"]),
            "indexRecords": 0,
            "indexCacheHit": cache_hit,
            "indexMs": index_ready_ms,
        })

    q_words = [w for w in dict.fromkeys([*(input_words or []), *(swow_pool or [])]) if w and len(w) >= 2]
    q_set = set(q_words)
    input_word_set = set(input_words or [])
    swow_word_set = set(swow_pool or [])
    if not q_words:
        return empty("empty-query", {
            "indexFiles": len(store["entries"]),
            "indexRecords": len(store["records"]),
            "indexCacheHit": cache_hit,
            "indexMs": index_ready_ms,
        })

    vote_map: OrderedDict[str, dict] = OrderedDict()  # 共现词 → {vote, layers, viaFiles, via, semanticPicks}
    hit_file_set: set[str] = set()
    layer_dist: dict[str, int] = {}
    _mdim_on = (os.environ.get("P1_DATA_MDIM") or "on") != "off"
    located = _locate_candidates(store, q_words)
    located_ms = _ms()
    configured_k1 = _opt_num(opts, "bm25K1")
    configured_b = _opt_num(opts, "bm25B")
    bm25_k1 = configured_k1 if (_finite(configured_k1) and configured_k1 > 0) \
        else float(os.environ.get("P1_DATA_BM25_K1") or 1.2)
    bm25_b = configured_b if (_finite(configured_b) and 0 <= configured_b <= 1) \
        else float(os.environ.get("P1_DATA_BM25_B") or 0.75)

    sparse_candidates = []
    # [0731] 层权配置通道: opts.layerWeights 覆盖; 未传(直连调用)=LAYER_W 原值
    layer_w = {**LAYER_W, **(opts.get("layerWeights") or {})}
    input_text_len = opts.get("inputTextLen") or 0
    for state in located.values():
        record = state["record"]
        hits = list(state["hits"])
        if len(hits) < min_hits_for(input_text_len, record["layer"], opts.get("candidateMinHits")):
            continue
        d_lex = _bm25_score(store, record, hits, bm25_k1, bm25_b)
        configured_weight = _js_number(record["weight"] if record["weight"] is not None else _UNDEF)
        weight = max(0.0, min(1.0, configured_weight)) if _finite(configured_weight) else 0.0
        d_imp = layer_w.get(record["layer"], layer_w.get("warm")) + weight
        sparse_candidates.append({
            "record": record, "hits": hits, "dLex": d_lex, "dImp": d_imp,
            "sparseScore": d_lex + d_imp, "dSem": 0.0,
        })
    sparse_candidates.sort(key=lambda c: -c["sparseScore"])  # stable
    config_sparse_top_k = _opt_num(opts, "sparseTopK")
    sparse_top_k = max(1, int(config_sparse_top_k)) if _finite(config_sparse_top_k) \
        else int(float(os.environ.get("P1_DATA_SPARSE_TOPK") or 100))
    scored_subs = sparse_candidates[:sparse_top_k]
    sparse_ready_ms = _ms()

    # NB300 是末段语义复核：没有稀疏候选时绝不加载；只计算 top-N 候选
    semantic_on = opts["nbRerank"] if isinstance(opts.get("nbRerank"), bool) else p1_data_vector_on()
    nb_pool = opts.get("nbPool")
    input_centroid = opts.get("inputCentroid")
    vector_backend = "provided" if nb_pool else None
    request_centroids: dict[int, np.ndarray | None] = {}
    subset_requested_words = 0
    semantic_error = None
    if semantic_on and scored_subs and not nb_pool:
        requested_words = dict.fromkeys([*(input_words or []), *q_words])
        for candidate in scored_subs:
            for word in candidate["record"]["tokens"]:
                requested_words[word] = None
        subset_requested_words = len(requested_words)
        try:
            nb_pool = subset_loader(list(requested_words), {"maxCacheVectors": opts.get("nbCacheMaxVectors")})
            vector_backend = "local-offset"
        except Exception as error:  # 响亮警告 + 稀疏候选保留（JS 同款诚实降级）
            semantic_error = str(error)
            print(f"[p1_node0_data_recall] NB300 subset unavailable; sparse candidates preserved: {semantic_error}",
                  file=sys.stderr)
            nb_pool = None

    # ── finishSemantic（JS 闭包在 Python 同步化为线性段）──
    if semantic_on and scored_subs:
        if input_centroid is None:
            # JS `a || b` 链: ndarray 不可做真值判断 → 显式 None 分支（语义等价）
            input_centroid = _centroid_from_words(input_words or [], nb_pool)
            if input_centroid is None:
                input_centroid = _centroid_from_words(q_words, nb_pool)
        if nb_pool and input_centroid is not None:
            for candidate in scored_subs:
                centroid = _record_centroid(candidate["record"], nb_pool, request_centroids)
                candidate["dSem"] = _cosine(input_centroid, centroid) if centroid is not None else 0.0
    semantic_ready_ms = _ms()
    configured_term_top_k = _opt_num(opts, "termTopK")
    term_top_k = max(1, int(configured_term_top_k)) if _finite(configured_term_top_k) \
        else int(float(os.environ.get("P1_DATA_TERM_TOPK") or 6))

    for candidate in scored_subs:
        hit_file_set.add(candidate["record"]["rel"])
        layer = candidate["record"]["layer"]
        layer_dist[layer] = layer_dist.get(layer, 0) + 1
        candidate["subTokens"] = candidate["record"]["tokens"]  # JS tokenSet 迭代序=tokens 插入序
        candidate["ent"] = candidate["record"]
    hit_files = len(hit_file_set)
    has_vec = bool(semantic_on and input_centroid is not None and nb_pool)
    vec_hit_files = sum(1 for c in scored_subs if c["dSem"] != 0) if has_vec else 0

    # ── 子条目四维证据：词面 / 候选子集语义 / 时近 / 重要性（三维归一等权, 空间相加不相乘）──
    applied_entry_top_k = None
    now_ms_opt = _opt_num(opts, "nowMs")
    if scored_subs:
        config_entry_top_k = _opt_num(opts, "entryTopK")
        entry_top_k = max(1, int(config_entry_top_k)) if _finite(config_entry_top_k) \
            else int(float(os.environ.get("P1_DATA_ENTRY_TOPK") or 20))  # S7-2 定档 20
        applied_entry_top_k = entry_top_k
        rdb = _opt_num(opts, "recencyDecayBase")
        recency_decay_base = max(0.9, min(1.0, rdb)) if _finite(rdb) else 0.995
        now_ms = now_ms_opt if _finite(now_ms_opt) else time.time() * 1000
        for candidate in scored_subs:
            event_ms = _date_parse_ms(candidate["record"]["timestamp"]) if candidate["record"]["timestamp"] else None
            candidate["dRec"] = (recency_decay_base ** max(0.0, (now_ms - event_ms) / 3_600_000)) \
                if event_ms is not None else None
        if _mdim_on:
            def normalize(key):
                values = [c[key] for c in scored_subs if c[key] is not None and _finite(c[key])]
                low = min(values) if values else 0
                high = max(values) if values else 0
                span = high - low
                for c in scored_subs:
                    v = c[key]
                    c["n" + key] = ((v - low) / span) if (v is not None and _finite(v) and span > 0) else None

            normalize("dLex")
            normalize("dSem")
            normalize("dRec")
            normalize("dImp")
            for c in scored_subs:
                dims = [c["ndLex"], c["ndSem"], c["ndRec"], c["ndImp"]]
                c["baseScore"] = sum(v for v in dims if v is not None and _finite(v))
        else:
            for c in scored_subs:
                c["baseScore"] = (c["dLex"] + max(0.0, c["dSem"]) + c["dImp"]
                                  + (0.0 if c["dRec"] is None else c["dRec"]))

        # BLQ 只消费已选候选的代表证据词；不生成候选、不写状态、不调用 transfer。
        n_records = len(store["records"])
        max_idf = _bm25_idf(max(1, n_records), 1) or 1
        for c in scored_subs:
            rep_list = sorted(
                ({"term": term, "idf": (_bm25_idf(n_records, len(store["postings"].get(term) or []))
                                        if store["postings"].get(term) else 0)}
                 for term in c["hits"]),
                key=lambda x: -x["idf"],
            )
            representative = rep_list[0] if rep_list else {"term": c["record"]["tokens"][0], "idf": 0}
            evidence_sources = []
            for term in c["hits"]:
                if term in input_word_set and "input" not in evidence_sources:
                    evidence_sources.append("input")
                if term in swow_word_set and "pool" not in evidence_sources:
                    evidence_sources.append("pool")
            c["evidenceSources"] = evidence_sources
            rep_idf = representative["idf"]
            blq = calc_blq({
                "term": representative["term"],
                "score": c["baseScore"],
                "_voteCount": len(c["hits"]),
                "_pathSupport": max(1, len(evidence_sources)),
                "_nbCos": c["dSem"] if (input_centroid is not None and nb_pool) else None,
            }, {
                "nb": nb_pool,
                "inputCentroid": input_centroid,
                "consumeConfirm": False,
                "specificity": lambda term, _idf=rep_idf: max(0.0, min(1.0, _idf / max_idf)),
            })
            c["blqScore"] = blq["blqScore"]
            c["blqAnnot"] = blq["annot"]
        blq_rerank = opts.get("blqRerank") is True
        for c in scored_subs:
            c["score"] = c["baseScore"] + (c["blqScore"] if blq_rerank else 0.0)
        scored_subs.sort(key=lambda c: (-c["score"], -c["baseScore"], c["record"]["recordId"]))
        for s in scored_subs[:entry_top_k]:
            picked = []
            if has_vec:
                # NB 是末段排序信号，不是词表门。向量内词按 cosine 排序；OOV 词按当前 corpus IDF 排序。
                semantic_terms = []
                sparse_terms = []
                for cw in s["subTokens"]:
                    if not cw or len(cw) < 2 or cw in q_set or cw in _exclude or _noise(cw):
                        continue
                    cw_vec = nb_pool.get(cw)
                    df = len(store["postings"].get(cw) or [])
                    idf = _bm25_idf(len(store["records"]), df) if df > 0 else 0
                    if cw_vec is not None:
                        semantic_terms.append({"word": cw, "semantic": _cosine(input_centroid, cw_vec), "idf": idf})
                    else:
                        sparse_terms.append({"word": cw, "idf": idf})
                semantic_terms.sort(key=lambda x: (-x["semantic"], -x["idf"]))
                sparse_terms.sort(key=lambda x: -x["idf"])
                semantic_quota = math.ceil(term_top_k / 2)
                selected_semantic = semantic_terms[:semantic_quota]
                for item in selected_semantic:
                    picked.append({"word": item["word"], "semantic": True})
                remaining = sorted(
                    [*({**item, "semantic": True} for item in semantic_terms[semantic_quota:]),
                     *({**item, "semantic": False} for item in sparse_terms)],
                    key=lambda x: -x["idf"],
                )
                for item in remaining[:max(0, term_top_k - len(picked))]:
                    picked.append({"word": item["word"], "semantic": item["semantic"]})
            else:
                sparse_terms = []
                for cw in s["subTokens"]:
                    if not cw or len(cw) < 2 or cw in q_set or cw in _exclude or _noise(cw):
                        continue
                    df = len(store["postings"].get(cw) or [])
                    sparse_terms.append({
                        "word": cw,
                        "idf": _bm25_idf(len(store["records"]), df) if df > 0 else 0,
                        "semantic": False,
                    })
                sparse_terms.sort(key=lambda x: -x["idf"])
                picked.extend(sparse_terms[:term_top_k])
            for item in picked:
                fw = item["word"]
                v = vote_map.get(fw)
                if v is None:
                    v = {"vote": 0.0, "layers": [], "viaFiles": [], "via": [], "semanticPicks": 0}
                    vote_map[fw] = v
                v["vote"] += s["score"]  # 子条目三维得分加性累计
                if item["semantic"]:
                    v["semanticPicks"] += 1
                if s["ent"]["layer"] not in v["layers"]:
                    v["layers"].append(s["ent"]["layer"])
                if s["ent"]["rel"] not in v["viaFiles"]:
                    v["viaFiles"].append(s["ent"]["rel"])
                for h in s["hits"]:
                    if h not in v["via"]:
                        v["via"].append(h)
    extraction_ready_ms = _ms()

    # rank 前软降权: DF-idf(特异性连续量) + BCC(超高频通用词) —— 降 vote 非删词
    log_h = math.log(hit_files + 1) or 1
    for word, v in vote_map.items():
        if hit_files > 1:
            v["vote"] *= math.log((hit_files + 1) / len(v["viaFiles"])) / log_h
        bcc_f = get_bcc_freq(word)
        if bcc_f > BCC_DEMOTE_GATE:
            v["vote"] *= BCC_DEMOTE
    ranked = sorted(vote_map.items(), key=lambda kv: -kv[1]["vote"])  # stable, 保插入序
    data_anchors = []
    for word, v in ranked:
        if len(data_anchors) >= ANCHOR_MAX:
            break
        if word in _seen:
            continue
        data_anchors.append({
            "node": word,
            "strength": min(STRENGTH_BASE + STRENGTH_STEP * v["vote"], STRENGTH_CAP),  # cap<0.7 召回不主导
            "_source": "data",
            "_vote": _fx(v["vote"], 2),
            "_layers": list(v["layers"]),
            "_via": list(v["via"])[:3],
            "_files": list(v["viaFiles"])[:2],
            "_semanticPicks": v["semanticPicks"],
        })

    collapse_same_file = opts.get("collapseSameFileKeywordSet") is not False
    selected_candidates = []
    superseded_records = []
    seen_revision_keys = set()
    for candidate in scored_subs:
        rec = candidate["record"]
        revision_key = (f"{rec['sourceRel']}\u0000{rec['metadataSignature']}"
                        if (collapse_same_file and rec["metadataSignature"] and rec["timestamp"]) else None)
        if revision_key and revision_key in seen_revision_keys:
            superseded_records.append(rec["recordId"])
            continue
        if revision_key:
            seen_revision_keys.add(revision_key)
        selected_candidates.append(candidate)
    record_top_k = _bounded_int(opts.get("recordTopK"), 5, 1, 50)
    recalled_records = []
    for candidate in selected_candidates[:record_top_k]:
        view = _record_view(candidate["record"], opts.get("snippetMaxChars"))
        view.update({
            "matchedTerms": list(candidate["hits"]),
            "evidenceSources": candidate.get("evidenceSources") or [],
            "dLex": _fx(candidate["dLex"], 6),
            "dSem": _fx(candidate["dSem"], 6),
            "dRec": None if candidate.get("dRec") is None else _fx(candidate["dRec"], 6),
            "dImp": _fx(candidate["dImp"], 6),
            "baseScore": _fx(candidate["baseScore"], 6),
            "blqScore": _fx(candidate["blqScore"], 6),
            "blqAnnot": candidate["blqAnnot"],
            "finalScore": _fx(candidate["score"], 6),
        })
        recalled_records.append(view)
    # [0731 002 注入输出线] injectMaxChars=注入总字符上限（0=不限）。records 已按关联度降序——
    #   累计 content 字数，超线的低关联记录整条删除；首条即超线也保留（有召回结果就至少给一条）。
    inject_dropped_by_budget = 0
    inject_max_chars = _bounded_int(opts.get("injectMaxChars"), 0, 0, 20000)
    if inject_max_chars > 0:
        budget = 0
        kept = []
        for record in recalled_records:
            budget += len(str(record.get("content") or ""))
            if budget > inject_max_chars and kept:
                inject_dropped_by_budget = len(recalled_records) - len(kept)
                break
            kept.append(record)
        recalled_records = kept

    trace_ = {
        "enabled": True,
        "backend": "memory-inverted",
        "injectMaxChars": inject_max_chars or 0,  # 0=不限
        "injectDroppedByBudget": inject_dropped_by_budget,  # 白盒：被输出线删除的低关联记录数（禁静默截断）
        "entryTopK": applied_entry_top_k,
        "termTopK": term_top_k,
        "sparseTopK": sparse_top_k,
        "indexCacheMax": _cache_max_indexes,
        "nbCacheMaxVectors": opts.get("nbCacheMaxVectors"),
        "bm25": {"k1": bm25_k1, "b": bm25_b},
        "indexFiles": len(store["entries"]),
        "indexRecords": len(store["records"]),
        "postingTerms": len(store["postings"]),
        "indexCacheHit": cache_hit,
        "located": len(located),
        "sparseAccepted": len(sparse_candidates),
        "semanticEnabled": semantic_on,
        "semanticAvailable": bool(input_centroid is not None and nb_pool),
        "semanticError": semantic_error,
        "vectorBackend": vector_backend,
        "subsetRequestedWords": subset_requested_words,
        "subsetLoadedWords": (len(nb_pool) if nb_pool else 0) if vector_backend == "local-offset" else None,
        "semanticReranked": vec_hit_files,
        "blqCalculated": len(scored_subs),
        "blqRerank": opts.get("blqRerank") is True,
        "collapseSameFileKeywordSet": collapse_same_file,
        "supersededRecords": superseded_records,
        "recordTopK": record_top_k,
        "scanned": len(store["records"]),
        "hitFiles": hit_files,
        "vecHitFiles": vec_hit_files,
        "layerDist": layer_dist,
        "qWords": len(q_words),
        "stagesMs": {
            "splitAndIndex": index_ready_ms,
            "locate": located_ms - index_ready_ms,
            "sparseSearch": sparse_ready_ms - located_ms,
            "nb300CandidateScore": semantic_ready_ms - sparse_ready_ms,
            "candidateFusionAndExtraction": extraction_ready_ms - semantic_ready_ms,
            "nb300Rerank": (extraction_ready_ms - sparse_ready_ms) if semantic_on else 0,
            "output": _ms() - extraction_ready_ms,
        },
        "totalMs": _ms(),
        "anchors": [f"{a['node']}({a['_vote']},{'+'.join(a['_layers'])})" for a in data_anchors],
        "selectedRecords": [{
            "recordId": r["recordId"],
            "layer": r["layer"],
            "sourceRel": r["sourceRel"],
            "timestamp": r["timestamp"],
            "timeSource": r["timeSource"],
            "contentLength": r["contentLength"],
            "contentHash": r["contentHash"],
            "matchedTerms": r["matchedTerms"],
            "evidenceSources": r["evidenceSources"],
            "dLex": r["dLex"],
            "dSem": r["dSem"],
            "dRec": r["dRec"],
            "dImp": r["dImp"],
            "baseScore": r["baseScore"],
            "blqScore": r["blqScore"],
            "finalScore": r["finalScore"],
        } for r in recalled_records],
    }
    trace("node0_data", lambda: {
        "input": {
            "memDirs": len([d for d in (mem_dirs if isinstance(mem_dirs, list) else [mem_dirs]) if d]),
            "indexRecords": len(store["records"]),
            "qWords": len(q_words),
        },
        "process": "条目拆分/分词→倒排posting定位→BM25稀疏搜索→层权融合与topK截断→NB300仅复核候选→锚点",
        "output": {
            "located": len(located),
            "sparseAccepted": len(sparse_candidates),
            "semanticReranked": vec_hit_files,
            "hitFiles": hit_files,
            "layerDist": layer_dist,
            "dataAnchors": trace_["anchors"],
            "stagesMs": trace_["stagesMs"],
        },
        "reason": (
            ("倒排未定位到候选" if not located
             else ("已定位条目，但未通过可配置的多词命中门槛" if not sparse_candidates
                   else "候选存在，但输出词均被既有信息词过滤器排除"))
            if not data_anchors else "候选链完整产出；NB300未参与全库候选生成"
        ),
    })

    return {
        "dataAnchors": data_anchors,
        "recalledRecords": recalled_records,
        "trace_": trace_,
        "inputCentroid": input_centroid,
        "nbPool": nb_pool,
    }


def recall_node0_data_async(mem_dirs, input_words, swow_pool, is_noise, seen_nodes, opts=None):
    """JS 异步变体在 Python 同步 I/O 下收敛为同步调用（语义等价：等 NB 子集就绪后继续）。"""
    return recall_node0_data(mem_dirs, input_words, swow_pool, is_noise, seen_nodes, opts)
