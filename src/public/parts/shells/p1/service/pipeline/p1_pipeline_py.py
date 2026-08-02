"""p1_pipeline_py.py — P1 自驱动管线入口（JS 平移: p1/p1_pipeline.mjs runPipeline 的 recallOnly 早退链）。

功能链：p1_server(POST /runP1) → run_pipeline(input_text, chat_history, mode, user_ctx, runtime_config)
        → {p1_act, recalledRecords, v5, directionWords, pyramid, cleanInfoWords, trace, whitebox}
        （返回块与 JS recallOnly 早退返回 逐字段一致——前端/getPromptHandler 消费方零改动）
范围（0731 设计定档）：
    插件生产契约是"只做召回"——记录在阶段1选出后立即返回，node3-10 后期发散既不执行也不平移。
    recallOnly != True 的调用在 Python 服务里是契约外路径 → 响亮报错（诚实降级不吞错），
    发散侧平移另立任务（勿据本文件误判"管线只有召回"）。
链路（对照 JS runPipeline 至 recallOnly return）：
    runtimeConfig 白名单 trace → Step-1 括号双信道 → recall(recall_v2, 主信道)
    → 副信道 recall(Set union 不取均值) → anchors 并入 swowPool → trace.recall 组装
    → whitebox 收取即清 → recallOnly 返回。
    _checkHotReload（AT/TI 词库 mtime 轮询→clearTransferCaches）监控的是发散侧词库，
    recallOnly 链虽在 JS 中也会执行该轮询，但其唯一效果（清 transfer 缓存）在本服务无对应物 → no-op（记录）。
关联链：→ p1_step1_bracket / p1_recall / resources.get_memory_dir / p1_whitebox
影响范围：纯计算只读；clear_p1_runtime_caches 提供 light/deep 分级卸载（002"词库缓存"内存关切）。
"""
from __future__ import annotations

import sys
import time

try:
    from .p1_whitebox import trace as wb_trace, get_trace, clear_trace
    from .p1_step1_bracket import split_bracket_channels
    from .p1_recall import recall_v2, clear_recall_caches
    from .resources import (
        get_memory_dir,
        get_resources_cache_stats,
        clear_resources_caches,
    )
    from . import p1_node0_data_recall as _node0_data
    from . import nb_subset as _nb_subset
except ImportError:
    from p1_whitebox import trace as wb_trace, get_trace, clear_trace
    from p1_step1_bracket import split_bracket_channels
    from p1_recall import recall_v2, clear_recall_caches
    from resources import (
        get_memory_dir,
        get_resources_cache_stats,
        clear_resources_caches,
    )
    import p1_node0_data_recall as _node0_data
    import nb_subset as _nb_subset

import os

_P1_BRACKET = os.environ.get("P1_BRACKET") != "off"  # Step -1 括号双信道门控（默认 on, 无括号零开销）

# runtimeConfig.recall 白名单（与 JS trace.runtimeConfig.recall 键集逐一对应）
_RECALL_CONFIG_KEYS = [
    "dataRecall", "recallOnly", "entryTopK", "resonanceW", "combinedMin",
    "nbGlobalRoute", "deferNb300", "nbRerank", "sparseTopK", "bm25K1", "bm25B",
    "termTopK", "contextMessages", "inputMaxChars", "shortSegmentChars",
    "excludeExactAssistantCopies", "recentDataTopK", "recordTopK",
    "candidateMinHits", "layerWeights", "collapseSameFileKeywordSet",
    "snippetMaxChars", "recencyDecayBase", "blqRerank", "includeMarkdown",
    "indexCacheMax", "nbCacheMaxVectors",
]


def _optional_call(module_name: str, fn_name: str):
    """跨分身缓存清理契约：分身A 模块的 clear_* 若已就绪则调用，缺席时透明记录（不静默不崩链）。"""
    try:
        import importlib

        mod = importlib.import_module(module_name)
    except ImportError:
        return {"status": "module-unavailable", "module": module_name}
    fn = getattr(mod, fn_name, None)
    if not callable(fn):
        return {"status": "fn-unavailable", "module": module_name, "fn": fn_name}
    try:
        return {"status": "cleared", "result": fn()}
    except Exception as e:  # 清缓存失败不拖垮调用方，但响亮记录
        print(f"[p1_pipeline_py] cache clear failed: {module_name}.{fn_name}: {e}", file=sys.stderr)
        return {"status": "error", "error": str(e)}


def get_p1_runtime_cache_stats() -> dict:
    """召回侧缓存统计（发散侧节点在 Python 服务不存在，键保留缺席标记防误读为"零占用"）。"""
    stats = {
        "dataRecall": _node0_data.get_data_recall_cache_stats(),
        "numberbatchSubset": _nb_subset.get_numberbatch_subset_cache_stats(),
        "resources": get_resources_cache_stats(),
    }
    for module_name, key, fn_name in (
        ("p1_node1_tokenize", "node1", "get_node1_tokenize_cache_stats"),
        ("p1_node2_swow", "node2", "get_node2_swow_cache_stats"),
        ("p1_pool", "pool", "get_recall_pool_cache_stats"),
    ):
        try:
            import importlib

            mod = importlib.import_module(module_name)
            fn = getattr(mod, fn_name, None)
            stats[key] = fn() if callable(fn) else {"status": "fn-unavailable"}
        except ImportError:
            stats[key] = {"status": "module-unavailable"}
    return stats


def clear_p1_runtime_caches(opts=None) -> dict:
    """分级卸载（对照 JS clearP1RuntimeCaches 0731 词库多段缓存设计）：
    tier="light"（idle 第一档）只清大体量/可按需重建的段——NB 子集向量 LRU（索引层保持热）、
      data 召回索引、pool mode 资源。保留召回热路径高频小段：node1 分词包、BCC 词典。
    tier="deep"（默认）全清，供长 idle/Unload 用。"""
    tier = "light" if (opts or {}).get("tier") == "light" else "deep"
    before = get_p1_runtime_cache_stats()

    actions = {}
    actions["dataRecall"] = {"status": "cleared", "result": _node0_data.clear_data_recall_cache()}
    actions["recall"] = {"status": "cleared", "result": clear_recall_caches()}
    actions["pool"] = _optional_call("p1_pool", "clear_recall_pool_caches")
    actions["node2"] = _optional_call("p1_node2_swow", "clear_node2_swow_caches")

    if tier == "deep":
        actions["node1"] = _optional_call("p1_node1_tokenize", "clear_node1_tokenize_caches")
        actions["resources"] = {"status": "cleared", "result": clear_resources_caches()}
        actions["numberbatchSubset"] = {"status": "cleared", "result": _nb_subset.clear_numberbatch_subset_cache()}
    else:
        # light: 只清向量 LRU，索引层/完整性备忘保持热（免 767MB 重校验）
        actions["numberbatchSubsetVectors"] = {"status": "cleared",
                                               "result": _nb_subset.clear_numberbatch_subset_vectors()}

    return {
        "clearedAt": int(time.time() * 1000),
        "tier": tier,
        "actions": actions,
        "before": before,
        "after": get_p1_runtime_cache_stats(),
    }


def run_pipeline(input_text, chat_history, mode, user_ctx=None, runtime_config=None) -> dict:
    """runPipeline recallOnly 平移。user_ctx={username, charName}；runtime_config={recall:{...}}。"""
    trace_out: dict = {}
    t_start = time.time()
    recall_config = None
    if isinstance(runtime_config, dict):
        recall_config = runtime_config.get("recall") or runtime_config or None
    trace_out["runtimeConfig"] = {
        "recall": (
            {**{k: recall_config[k] for k in _RECALL_CONFIG_KEYS if k in recall_config},
             "recallOnly": recall_config.get("recallOnly") is True}
            if recall_config else None
        ),
    }

    # 契约门（见文件头"范围"）：Python 服务只承载召回链
    if not recall_config or recall_config.get("recallOnly") is not True:
        raise ValueError(
            "p1_pipeline_py 只实现 recallOnly 召回链（插件生产契约'只做召回'）；"
            "发散侧 node3-10 未平移——传 runtime_config={'recall': {'recallOnly': True, ...}}"
        )

    # _checkHotReload: 发散侧 AT/TI 词库轮询在本服务无对应缓存 → no-op（文件头已记录）

    # ── Step -1: 括号双信道前置层(早于分词) ──
    if _P1_BRACKET:
        _bracket = split_bracket_channels(input_text)
    else:
        _bracket = {"main": input_text, "sub": None, "hasBracket": False, "bracketCount": 0}
    _main_text = _bracket["main"] or input_text
    trace_out["step1_bracket"] = {
        "hasBracket": _bracket["hasBracket"],
        "bracketCount": _bracket["bracketCount"],
        "main": str(_main_text)[:80],
        "sub": _bracket["sub"][:80] if _bracket["sub"] else None,
    }

    # ── 阶段1: recall_v2 分词+SWOW发散(主信道) ──
    # C3: memDirs = 角色级 + _global 记忆根；user_ctx 缺席 → None（与 JS test/lab 路径零回归一致）
    _recall_mem_dirs = None
    if user_ctx and user_ctx.get("username") and user_ctx.get("charName"):
        try:
            _recall_mem_dirs = [
                get_memory_dir(user_ctx["username"], user_ctx["charName"]),
                get_memory_dir(user_ctx["username"], "_global"),
            ]
        except (ValueError, OSError) as error:
            _recall_mem_dirs = None
            print(f"[p1_pipeline_py] data recall memory path resolution failed: {error}", file=sys.stderr)
    seen_nodes: set = set()
    recall_opts = {
        "memDirs": _recall_mem_dirs,
        "excludeWords": [user_ctx["username"], user_ctx["charName"]] if user_ctx else [],
        "mode": mode,
        "config": recall_config,
    }
    try:
        recall_result = recall_v2(_main_text, chat_history, seen_nodes, recall_opts)
    except Exception as error:  # callNode fallback 语义: 单节点崩溃不拖垮 runPipeline, 响亮告警走降级值
        print(f"[p1_pipeline_py] recall node failed, using fallback: {error}", file=sys.stderr)
        recall_result = {"inputWords": [], "swowPool": set(), "anchors": [], "inputCentroid": None,
                        "linguisticSignals": {}, "intensifiers": [], "trace": {}}

    input_words = recall_result.get("inputWords") or (recall_result.get("trace") or {}).get("inputWords") or []
    swow_pool = recall_result.get("swowPool")
    if swow_pool is None:
        swow_pool = set(input_words)
    recalled_records = recall_result.get("recalledRecords")
    if not isinstance(recalled_records, list):
        recalled_records = []

    # ── Step -1 副信道: 括号内真情绪另走一次 recall_v2 → Set union 合并(不取均值, 保留张力) ──
    if _P1_BRACKET and _bracket["hasBracket"] and _bracket["sub"]:
        _sub_seen: set = set()
        try:
            _sub_recall = recall_v2(_bracket["sub"], chat_history, _sub_seen,
                                    {"mode": mode, "config": recall_config})
        except Exception as error:
            print(f"[p1_pipeline_py] sub-channel recall failed, using fallback: {error}", file=sys.stderr)
            _sub_recall = {"inputWords": [], "swowPool": set(), "trace": {}}
        _sub_words = _sub_recall.get("inputWords") or []
        _sub_pool = _sub_recall.get("swowPool")
        if _sub_pool is None:
            _sub_pool = set(_sub_words)
        _sub_merged = 0
        for w in _sub_pool:
            if w not in swow_pool:
                swow_pool.add(w)
                _sub_merged += 1
        for w in _sub_words:
            if w and w not in input_words:
                input_words.append(w)
        trace_out["step1_bracket"]["subInputWords"] = _sub_words[:8]
        trace_out["step1_bracket"]["subPoolSize"] = len(_sub_pool)
        trace_out["step1_bracket"]["subMergedIntoMain"] = _sub_merged

    anchors = recall_result.get("anchors") or []
    for a in anchors:  # 锚点加入散词池参与定位
        node = a.get("node")
        if node and len(node) >= 2:
            swow_pool.add(node)

    r_trace = recall_result.get("trace") or {}
    trace_out["recall"] = {
        "inputWords": input_words,
        "swowPoolSize": len(swow_pool),
        "swowPool": list(swow_pool),
        "anchorCount": len(anchors),
        "anchors": [a.get("node") for a in anchors[:5]],
        "dataRecall": r_trace.get("dataRecall"),
        "context": r_trace.get("context"),
        "recentData": r_trace.get("recentData"),
        "recalledRecords": [{
            "recordId": r.get("recordId"),
            "layer": r.get("layer"),
            "sourceRel": r.get("sourceRel"),
            "timestamp": r.get("timestamp"),
            "matchedTerms": r.get("matchedTerms"),
            "baseScore": r.get("baseScore"),
            "blqScore": r.get("blqScore"),
            "finalScore": r.get("finalScore"),
            "contentLength": r.get("contentLength"),
            "contentHash": r.get("contentHash"),
        } for r in recalled_records],
        "pool": r_trace.get("pool"),
        "scoredCtx": r_trace.get("scoredCtx"),
        "ms": int((time.time() - t_start) * 1000),
    }
    # [白盒·跨节点接口] 阶段1 recall
    wb_trace("pipeline:recall", lambda: {
        "input": {"mainText": str(_main_text)[:60], "hasBracket": bool(_bracket.get("hasBracket"))},
        "process": "recall_v2: jieba分词去虚词 → 每词SWOW top6联想 → 散词池 + NB300质心 + 锚点",
        "output": {"inputWords": len(input_words), "swowPoolSize": len(swow_pool),
                   "anchors": len(anchors), "hasCentroid": recall_result.get("inputCentroid") is not None},
        "reason": ("inputWords=0 → 分词断流(定位 recall fallback), 全链路必空" if not input_words
                   else ("swowPool≈inputWords → SWOW未发散(资源/distance), 下游候选稀薄"
                         if len(swow_pool) <= len(input_words)
                         else "正常: SWOW已发散出散词池")),
    })

    # 插件生产契约"只做召回"：记录已在阶段1选出后立即返回，node3-10 不执行。
    _wb_data = get_trace()
    clear_trace()
    trace_out["recallOnly"] = True
    trace_out["totalMs"] = int((time.time() - t_start) * 1000)
    return {
        "p1_act": [],
        "recalledRecords": recalled_records,
        "v5": None,
        "directionWords": [],
        "pyramid": None,
        "cleanInfoWords": [],
        "trace": trace_out,
        "whitebox": _wb_data,
    }
