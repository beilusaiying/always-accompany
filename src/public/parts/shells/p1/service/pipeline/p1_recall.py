"""p1_recall.py — 阶段1: 收拢₁ 编排器（JS 平移: p1/p1_recall.mjs，纯编排不含算法）。

功能链：p1_pipeline_py → recall_v2(input_text, chat_history, seen_nodes, opts)
        → {anchors, recalledRecords, trace, inputCentroid, swowPool, inputWords, linguisticSignals, intensifiers}
本文件只做：净化口 prepare_recall_context + 节点串联(node1→node2→pool→node0-data→node0)
        + linguisticSignals 信号 + 组装 recallResult（13契约§1.A，字段严格不变）。
关联链（跨分身接口契约——已按分身A 落盘实签对齐 0731 21:50）：
  → p1_node1_tokenize.tokenize_recall(text) -> {"inputWords": [...], "_isNoise": fn}
  → p1_node1_tokenize.tokenize_node1(text, ctx_text, config) -> {"words", "intensifiers", "_trace"}
  → p1_node1_tokenize.soft_limit_recall_text(text, max_chars, short_segment_chars)
        -> {"text","originalLength","processedLength","truncated","strategy"}（0731 定档 head-tail）
  → p1_node1_tokenize._is_noise_recall(word) -> bool（JS _isNoiseRecall）
  → p1_node2_swow.diverge_node2(input_words, is_noise, {"deferNb300"})
        -> {"swowPool": set, "inputCentroid", "nbPool", "trace_": {"inputSwowSize": int}}
  → p1_pool.build_recall_pool({...}) -> {"swowPool": set, "poolMap": dict|None, "trace": {...}}
  → p1_node0_anchor.recall_node0 / p1_node0_data_recall.recall_node0_data + prepare_data_recall（分身B）
影响范围：纯计算只读；clear_recall_caches 只清本文件 linguistic_signals 缓存（同 JS）。
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata

try:
    from .p1_whitebox import trace  # noqa: F401  (与 JS 同款保留 import；本文件不直接埋点)
    from .resources import resolve_resource
    from .p1_node1_tokenize import (
        tokenize_recall,
        tokenize_node1,
        soft_limit_recall_text,
        _is_noise_recall as is_noise_recall,
    )
    from .p1_node2_swow import diverge_node2
    from .p1_node0_anchor import recall_node0
    from .p1_node0_data_recall import (
        recall_node0_data,
        prepare_data_recall,
    )
    from .p1_pool import build_recall_pool
except ImportError:
    from p1_whitebox import trace  # noqa: F401
    from resources import resolve_resource
    from p1_node1_tokenize import (
        tokenize_recall,
        tokenize_node1,
        soft_limit_recall_text,
        _is_noise_recall as is_noise_recall,
    )
    from p1_node2_swow import diverge_node2
    from p1_node0_anchor import recall_node0
    from p1_node0_data_recall import (
        recall_node0_data,
        prepare_data_recall,
    )
    from p1_pool import build_recall_pool

# 走框架: P1_NODE1_V2 默认 on=框架版 tokenize_node1(分离 intensifiers)；off 回退 tokenize_recall 零回归口径。
_P1_NODE1_V2 = os.environ.get("P1_NODE1_V2") != "off"

_WS_RE = re.compile(r"\s+")


def _normalized_message_identity(value):
    return _WS_RE.sub(" ", unicodedata.normalize("NFKC", str(value or ""))).strip()


def _finite_int(value, lo, hi, fallback):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    import math
    if not math.isfinite(n):
        return fallback
    return max(lo, min(hi, int(n)))


def prepare_recall_context(input_text, chat_history, config=None):
    """召回上下文唯一净化口。只保留最近用户消息；assistant 只用于"用户是否整段复制 earlier AI"的
    精确证据，本身绝不进入 recall context。（JS prepareRecallContext 逐字段平移）"""
    config = config or {}
    context_messages = _finite_int(config.get("contextMessages"), 0, 20, 5)
    exclude_exact_assistant_copies = config.get("excludeExactAssistantCopies") is not False
    history = chat_history if isinstance(chat_history, list) else []
    current_identity = _normalized_message_identity(input_text)
    assistant_seen: set[str] = set()
    user_candidates = []
    skipped_assistant_ids = []
    skipped_copied_ai_ids = []

    for index, message in enumerate(history):
        message = message or {}
        role = message.get("role")
        content_raw = message.get("content")
        if content_raw is None:
            content_raw = message.get("mes")
        content = str(content_raw if content_raw is not None else "")
        identity = _normalized_message_identity(content)
        message_id = message.get("id")
        if message_id is None:
            message_id = message.get("messageId")
        if message_id is None:
            message_id = str(index)
        if role == "assistant":
            if identity:
                assistant_seen.add(identity)
            skipped_assistant_ids.append(message_id)
            continue
        if role != "user" or not identity:
            continue
        if exclude_exact_assistant_copies and identity in assistant_seen:
            skipped_copied_ai_ids.append(message_id)
            continue
        user_candidates.append({"index": index, "id": message_id, "content": content, "identity": identity})

    input_copied_assistant = (exclude_exact_assistant_copies
                              and bool(current_identity)
                              and current_identity in assistant_seen)
    skipped_current_duplicate_ids = []
    last_history_index = len(history) - 1
    last_candidate = user_candidates[-1] if user_candidates else None
    if (last_candidate
            and last_candidate["index"] == last_history_index
            and last_candidate["identity"] == current_identity):
        skipped_current_duplicate_ids.append(last_candidate["id"])
        user_candidates.pop()

    selected = []
    # JS slice(-contextMessages): contextMessages=0 → slice(-0)=全量（python [-0:] 同语义）
    for candidate in user_candidates[-context_messages:]:
        # 分身A 契约: soft_limit_recall_text(text, max_chars, short_segment_chars) 位置参数
        preprocess = soft_limit_recall_text(
            candidate["content"], config.get("inputMaxChars"), config.get("shortSegmentChars"),
        )
        selected.append({
            "role": "user",
            "content": preprocess["text"],
            "id": candidate["id"],
            "_preprocess": preprocess,
        })
    input_preprocess = soft_limit_recall_text(
        "" if input_copied_assistant else input_text,
        config.get("inputMaxChars"), config.get("shortSegmentChars"),
    )
    public_history = [{"role": m["role"], "content": m["content"]} for m in selected]
    return {
        "inputText": input_preprocess["text"],
        "history": public_history,
        "contextText": "\n".join(m["content"] for m in public_history),
        "trace": {
            "contextMessages": context_messages,
            "excludeExactAssistantCopies": exclude_exact_assistant_copies,
            "inputCopiedAssistant": input_copied_assistant,
            "inputPreprocess": input_preprocess,
            "acceptedUserContextIds": [m["id"] for m in selected],
            "skippedAssistantIds": skipped_assistant_ids,
            "skippedCopiedAiIds": skipped_copied_ai_ids,
            "skippedCurrentDuplicateIds": skipped_current_duplicate_ids,
            "contextSoftLimits": [{
                "id": m["id"],
                "originalLength": m["_preprocess"].get("originalLength"),
                "processedLength": m["_preprocess"].get("processedLength"),
                "truncated": m["_preprocess"].get("truncated"),
                "strategy": m["_preprocess"].get("strategy"),
            } for m in selected],
        },
    }


def recall_v2(input_text, chat_history, seen_nodes, opts=None, data_recall_fn=recall_node0_data):
    """阶段1召回侧编排(串 节点1→2→pool→0-data→0)；返回 13 契约 §1.A 字段严格不变。"""
    opts = opts or {}
    recall_config = opts.get("config") or {}
    request_context = prepare_recall_context(input_text, chat_history, recall_config)
    sanitized_input = request_context["inputText"]
    sanitized_history = request_context["history"]
    _mem_dirs = opts.get("memDirs")
    if _mem_dirs:
        prepared_data = prepare_data_recall(_mem_dirs, {
            "dataRecall": recall_config.get("dataRecall"),
            "mode": opts.get("mode"),
            "indexCacheMax": recall_config.get("indexCacheMax"),
            "recentDataTopK": recall_config.get("recentDataTopK"),
            "snippetMaxChars": recall_config.get("snippetMaxChars"),
            "includeMarkdown": recall_config.get("includeMarkdown", True),
        })
    else:
        prepared_data = {
            "store": None,
            "cacheHit": False,
            "recentRecords": [],
            "trace_": {
                "enabled": recall_config.get("dataRecall") is not False,
                "backend": "memory-inverted",
                "reason": "no-memory-dirs",
                "indexFiles": 0,
                "indexRecords": 0,
                "totalMs": 0,
            },
        }
    recent_data_text = "\n".join(
        r["content"] for r in (prepared_data.get("recentRecords") or []) if r.get("content")
    )
    context_text = "\n".join(t for t in [request_context["contextText"], recent_data_text] if t)

    # 节点1: 分词去虚词 → inputWords + 复用的 _isNoise
    intensifiers = []
    if _P1_NODE1_V2:
        r1 = tokenize_node1(sanitized_input, context_text, recall_config)
        input_words = r1.get("words") or []
        intensifiers = r1.get("intensifiers") or []
        _is_noise = is_noise_recall
        request_context["trace"]["node1"] = r1.get("_trace")
    else:
        r1 = tokenize_recall(sanitized_input)
        input_words = r1.get("inputWords") or []
        _is_noise = r1.get("_isNoise")

    # 节点2: 生产默认只做 SWOW 多词定位；NB300 延迟到稀疏候选产生后（deferNb300 默认 on）。
    n2 = diverge_node2(input_words, _is_noise, {"deferNb300": recall_config.get("deferNb300") is not False})
    _n2_pool = n2.get("swowPool")
    input_centroid = n2.get("inputCentroid")
    nb_pool = n2.get("nbPool")
    n2_trace = n2.get("trace_") or {}

    # ── 多路发散池(119号MD S1): 四路接口→合并一池, 池逻辑单源收口在 p1_pool ──
    pool_result = build_recall_pool({
        "inputText": sanitized_input,
        "inputWords": input_words,
        "chatHistory": sanitized_history,
        "mode": opts.get("mode"),
        "swowPool": _n2_pool,
        "inputCentroid": input_centroid,
        "nbPool": nb_pool,
        "recallConfig": opts.get("config"),
    })
    swow_pool = pool_result.get("swowPool")
    pool_map = pool_result.get("poolMap")
    pool_trace = pool_result.get("trace")

    # data 必须先产生稀疏候选和请求局部 NB subset；Node0 随后复用同一 subset。
    data_anchors = []
    recalled_records = []
    data_trace = prepared_data["trace_"]

    if _mem_dirs:
        data_result = data_recall_fn(_mem_dirs, input_words, swow_pool, _is_noise, seen_nodes, {
            "excludeWords": opts.get("excludeWords"),
            "mode": opts.get("mode"),
            "prepared": prepared_data,
            "inputCentroid": input_centroid,
            "nbPool": nb_pool,
            "inputTextLen": len(sanitized_input),  # C4(139号): 分级门槛 minHitsFor 消费(句长分档)
            "dataRecall": recall_config.get("dataRecall"),
            "entryTopK": recall_config.get("entryTopK"),
            "recordTopK": recall_config.get("recordTopK"),
            "injectMaxChars": recall_config.get("injectMaxChars"),  # [0731 002] 注入输出线
            "candidateMinHits": recall_config.get("candidateMinHits"),
            "layerWeights": recall_config.get("layerWeights"),  # [0731] 层权 → node0 dImp(缺省=LAYER_W)
            "collapseSameFileKeywordSet": recall_config.get("collapseSameFileKeywordSet", True),
            "recentDataTopK": recall_config.get("recentDataTopK"),
            "snippetMaxChars": recall_config.get("snippetMaxChars"),
            "includeMarkdown": recall_config.get("includeMarkdown", True),
            "nbRerank": recall_config.get("nbRerank"),
            "blqRerank": recall_config.get("blqRerank"),
            "recencyDecayBase": recall_config.get("recencyDecayBase"),
            "sparseTopK": recall_config.get("sparseTopK"),
            "bm25K1": recall_config.get("bm25K1"),
            "bm25B": recall_config.get("bm25B"),
            "termTopK": recall_config.get("termTopK"),
            "indexCacheMax": recall_config.get("indexCacheMax"),
            "nbCacheMaxVectors": recall_config.get("nbCacheMaxVectors"),
        })
        # mergeDataRecall
        if input_centroid is None and data_result.get("inputCentroid") is not None:
            input_centroid = data_result["inputCentroid"]
        if nb_pool is None and data_result.get("nbPool") is not None:
            nb_pool = data_result["nbPool"]
        data_anchors = data_result.get("dataAnchors") or []
        recalled_records = data_result.get("recalledRecords") or []
        if data_result.get("trace_"):
            data_trace = data_result["trace_"]

    # ── finishRecall ──
    # 节点0: 只消费已净化用户上下文，并复用 data 阶段产生的 NB subset。
    n0 = recall_node0(
        sanitized_history,
        swow_pool,
        input_centroid,
        nb_pool,
        _is_noise,
        seen_nodes,
        pool_map,
        {
            "combinedMin": recall_config.get("combinedMin"),
            "contextMessages": recall_config.get("contextMessages"),
        },
    )
    context_anchors = n0["anchors"]
    n0_trace = n0["trace_"]
    anchors = [*context_anchors, *data_anchors]
    # trace 组装: 字段与拆分前 recallV2 一致
    trace_out = {
        "inputWords": input_words,
        "inputSwowSize": n2_trace.get("inputSwowSize"),
        "ctxSentences": n0_trace.get("ctxSentences"),
        "scoredCtx": n0_trace.get("scoredCtx"),
        "anchors": n0_trace.get("anchors"),
        "context": request_context["trace"],
        "recentData": prepared_data["trace_"],
        "dataRecall": data_trace,
        "pool": pool_trace,  # 多路池白盒(119§2)
    }

    linguistic_signals = detect_linguistic_signals(sanitized_input)

    # ── 元话语词激活(词库线A, P1_METADISCOURSE_TERMS 默认on, 仅 chat mode) ──
    if ((os.environ.get("P1_METADISCOURSE_TERMS") or "on").lower() == "on"
            and (opts.get("mode") or "chat") == "chat"
            and linguistic_signals.get("metadiscourse")):
        _md_map = (_ling_signals or {}).get("metadiscourse_terms") or {}
        _md_seen = {a["node"] for a in anchors}
        for t in dict.fromkeys(m["type"] for m in linguistic_signals["metadiscourse"]):
            for term in (_md_map.get(t) or []):
                if term in _md_seen:
                    continue
                _md_seen.add(term)
                anchors.append({"node": term, "strength": 0.6, "_source": "metadiscourse:" + t})

    return {
        "anchors": anchors,
        "recalledRecords": recalled_records,
        "trace": trace_out,
        "inputCentroid": input_centroid,
        "swowPool": swow_pool,
        "inputWords": input_words,
        "linguisticSignals": linguistic_signals,
        "intensifiers": intensifiers,
    }


def recall_v2_async(input_text, chat_history, seen_nodes, opts=None):
    """JS 异步变体在 Python 同步 I/O 下收敛为同步（NB 子集初始化同步完成）。"""
    return recall_v2(input_text, chat_history, seen_nodes, opts)


_ling_signals = None
_ling_regex_cache = None  # 预编译缓存: particles/burns 单例


def _load_ling_signals():
    global _ling_signals, _ling_regex_cache
    if _ling_signals is not None:
        return _ling_signals
    try:
        p = resolve_resource("linguistic_signals.json")
        if p is None:
            raise FileNotFoundError("linguistic_signals.json not found in resource candidates")
        _ling_signals = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"[p1_recall] linguistic_signals load failed: {e}", file=sys.stderr)
        _ling_signals = {}
    _ling_regex_cache = {"particles": {}, "burns": {}}
    for particle in (_ling_signals.get("sentence_final_particles") or {}):
        try:
            _ling_regex_cache["particles"][particle] = re.compile(
                re.escape(particle) + r"[\s？?！!。.]*$"
            )
        except re.error:
            pass
    for key, definition in (_ling_signals.get("burns_absolutizing") or {}).items():
        pattern = definition.get("pattern") if isinstance(definition, dict) else None
        if pattern:
            try:
                _ling_regex_cache["burns"][key] = re.compile(pattern)
            except re.error:
                pass  # JS 正则方言差异: 编译失败的 pattern 该 key 不参与检测(与 JS 行为差异点, 报告记录)
    return _ling_signals


def detect_linguistic_signals(text):
    sig = _load_ling_signals()
    result = {"particles": [], "metadiscourse": [], "burns": []}
    if not text:
        return result
    for particle, info in (sig.get("sentence_final_particles") or {}).items():
        pre = _ling_regex_cache["particles"].get(particle)
        if text.endswith(particle) or (pre is not None and pre.search(text)):
            entry = {"particle": particle}
            if isinstance(info, dict):
                entry.update(info)
            result["particles"].append(entry)
    for sig_type, phrases in (sig.get("metadiscourse") or {}).items():
        if sig_type == "metadiscourse_terms":
            continue  # 映射表非短语组（JS 侧该键在顶层, 防护性跳过）
        for phrase in (phrases or []):
            if isinstance(phrase, str) and phrase in text:
                result["metadiscourse"].append({"type": sig_type, "phrase": phrase})
                break
    for key, definition in (sig.get("burns_absolutizing") or {}).items():
        pre = _ling_regex_cache["burns"].get(key)
        if pre is not None and pre.search(text):
            result["burns"].append({"key": key, "type": definition.get("type") if isinstance(definition, dict) else None})
    return result


def clear_recall_caches():
    """同 JS：只清本文件 linguistic_signals 缓存（节点缓存由各节点自管理）。"""
    global _ling_signals, _ling_regex_cache
    _ling_signals = None
    _ling_regex_cache = None
