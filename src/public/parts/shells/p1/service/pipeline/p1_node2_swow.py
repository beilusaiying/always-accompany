# ════════════════════════════════════════════════════════════════════
# p1_node2_swow.py — 节点2: SWOW 发散 + NB300 质心（P1 三段机制第二段 = 发散）
# [JS 平移真身: src/yonban/core/functions/memory/p1/p1_node2_swow.mjs, 2026-07-31 定档态]
#
# 功能链：p1_pipeline.py(主AI织合) → diverge_node2(inputWords, isNoise, opts)
#         → {swowPool, inputCentroid, nbPool, trace_}（字段名与 JS 一致）
# why：SWOW 是 P1 发散引擎核心，把输入词联想扩展为散词池（distance=4-5 非同义）；
#      生产链默认 deferNb300=True（SWOW 多词定位早退，NB300 延后到稀疏候选之后）。
# 关联链：
#   → resources_node1.py（swow_diverge/SWOW cue 字典/BCC/停用词/口语补集/NB provider）
#   → p1_node1_tokenize.py（DEGREE_WORDS 程度副词白名单同源, 框架红线"程度副词不排"）
# 红线（照 JS 头注释）：distance=1 同义扩散禁用；禁逐词发散（只 QKV 池交汇）；
#   0731 英文断点①修复: 英文联想词 minSupport=1（SWOW-en 独立网络, support≥2 结构性饿死英文扩散）。
# NB300 非延迟路径依赖 resources_node1.set_numberbatch_provider 接线（分身B）；
#   未接线时 nbPool=None → 质心/ QKV 跳过 = JS getNumberbatch 缺席时的同一退化路径。
# ════════════════════════════════════════════════════════════════════
from __future__ import annotations

import math
import os
import re
from typing import Any, Callable, Optional

try:
    from . import resources_node1 as res
    from .p1_node1_tokenize import DEGREE_WORDS
except ImportError:  # 独立脚本运行时退化为平级 import
    import resources_node1 as res
    from p1_node1_tokenize import DEGREE_WORDS

NB_DIM = 300
# [对照 node2:SWOW_TOPK] 每个输入词 SWOW 联想词数; 默认6=旧值
SWOW_TOPK = int(res.env_num("P1_N2_SWOW_TOPK", 6))

# ── SWOW distance 门控（凛倾红线 #6: distance 4-5, 禁 distance=1 同义）[对照 node2:_N2_DISTANCE] ──
_N2_DISTANCE = os.environ.get("P1_N2_SWOW_DISTANCE", "on").lower()  # on=已判正转正(0703)
# ── QKV 质心 cue 注入约束 [对照 node2:_QKV_GUARD/QKV_CUE_COS_MIN] 默认 off ──
_QKV_GUARD = os.environ.get("P1_N2_QKV_GUARD", "off").lower() == "on"
QKV_CUE_COS_MIN = res.env_num_or("P1_N2_QKV_COS_MIN", 0.35)  # [待实验定] cue↔质心最低余弦

# ── QKV 池交汇参数 [对照 node2:QKV_*] ──
QKV_MIN_INPUTS = 2                                    # 强制≥2词才走交汇(反一词喷)
QKV_TOP_CUES = int(res.env_num("P1_N2_QKV_CUES", 3))  # 交汇 cue 数(池尺寸真旋钮)
QKV_CUE_ASSOC = int(res.env_num("P1_N2_QKV_ASSOC", 3))  # 每交汇 cue 联想词数
QKV_MODE = os.environ.get("P1_N2_QKV", "on").lower()  # off / on(默认) / centroid_only

# ── 质心 fallback [对照 node2:_P1_CENTROID_FALLBACK] 默认 off ──
_P1_CENTROID_FALLBACK = os.environ.get("P1_N2_CENTROID_FALLBACK") == "on"

# ── BCC 超高频判据（"BCC+其他"的"BCC"半边）[对照 node2:BCC_SUPERHIGH_N2 实测定 80w] ──
BCC_SUPERHIGH_N2 = 800000


def _is_non_info_n2(w: Optional[str], input_set: Any, is_noise: Callable[[str], bool]) -> str:
    """节点2出口非信息词判定 [对照 node2:_isNonInfoN2 优先级逐行]:
    原词保护 > 程度副词豁免 > POS虚词 > BCC超高频 > 停用词 > 口语补集。返回判据标签, ""=保留。"""
    if not w or len(w) < 2:
        return "len"          # 单字/空: SWOW 单字发散无信息(发散侧从严)
    if w in input_set:
        return ""             # ① 用户原话词绝不排(凛倾红线)
    if w in DEGREE_WORDS:
        return ""             # ② 程度副词豁免(框架红线, 与 node1 同源)
    if is_noise(w):
        return "pos"          # POS 虚词(复合标签归一后能拦疑问代词)
    if res.get_bcc_freq(w) > BCC_SUPERHIGH_N2:
        return "bcc"          # BCC 超高频纯功能词(我们/一个/没有...)
    if res.is_stopword(w):
        return "stop"         # 停用词4份union(怎么/如此/这样/什么...)
    if w in res.get_colloquial_noninfo():
        return "colloq"       # 口语疑问补集(BCC+停用词盲区: 干嘛/没事/什么事...)
    return ""


def _cos300(a: Any, b: Any) -> Optional[float]:
    """[对照 node2:_cos300] NB300 余弦; 任一为空/零范数 → None。"""
    if a is None or b is None:
        return None
    d = na = nb2 = 0.0
    for i in range(NB_DIM):
        d += a[i] * b[i]
        na += a[i] * a[i]
        nb2 += b[i] * b[i]
    den = math.sqrt(na) * math.sqrt(nb2)
    return d / den if den else None


def _nb_get(pool: Any, w: str) -> Any:
    """nbPool 取向量（dict / 自带 .get 的 Map 形状均可）。"""
    if pool is None:
        return None
    try:
        return pool.get(w)
    except AttributeError:
        return None


def _nb_size(pool: Any) -> int:
    if pool is None:
        return 0
    try:
        return len(pool)
    except TypeError:
        return 0


_IS_EN_WORD2_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")  # [对照 node2:_isEnWord2]


def _normalize_centroid(vecs: list[Any]) -> Optional[list[float]]:
    """[对照 node2 质心块] 向量均值 → L2 归一化。"""
    if not vecs:
        return None
    centroid = [0.0] * NB_DIM
    for v in vecs:
        for i in range(NB_DIM):
            centroid[i] += v[i]
    n = 0.0
    for i in range(NB_DIM):
        centroid[i] /= len(vecs)
        n += centroid[i] ** 2
    n = math.sqrt(n) or 1.0
    for i in range(NB_DIM):
        centroid[i] /= n
    return centroid


def diverge_node2(input_words: list[str], is_noise: Any = None, opts: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """节点2 主函数(纯函数 in→out)。[对照 node2:divergeNode2 全函数逐段平移]
    返回 {swowPool(OrderedSet), inputCentroid, nbPool, trace_}。"""
    _noise: Callable[[str], bool] = is_noise if callable(is_noise) else (lambda w: False)
    # [对照 JS] 安全默认是末段 NB: 只有显式传 deferNb300=False 才允许旧的早载路径
    defer_nb300 = not (opts is not None and opts.get("deferNb300") is False)

    swow_pool = res.OrderedSet(input_words)

    # ── 生产默认: SWOW 多词交集定位, NB300 延后（deferNb300 早退分支）──
    if defer_nb300:
        input_set = set(input_words)
        assoc: dict[str, dict[str, Any]] = {}  # 插入序保留 = JS Map
        for input_word in input_words:
            seen_for_input: set[str] = set()
            for item in res.swow_diverge(input_word, SWOW_TOPK):
                word = item.get("word")
                if not word or word in input_set or word in seen_for_input:
                    continue
                seen_for_input.add(word)
                state = assoc.get(word)
                if state is None:
                    state = {"word": word, "support": 0, "score": 0.0, "rank": math.inf}
                    assoc[word] = state
                state["support"] += 1
                strength = item.get("strength")
                state["score"] += (strength if res.is_finite_number(strength)
                                   else 1 / max(1, item.get("rank") or 1))
                state["rank"] = min(state["rank"], item.get("rank") or math.inf)
        min_support = 2 if len(input_words) > 1 else 1
        # [0731 英文断点①修复·002拍板] 英文联想词 minSupport=1: SWOW-en 独立网络, 英文技术词
        #   top6 联想互不重叠, support≥2 结构性饿死英文扩散; 中文保持原门槛零回归。
        located = sorted(
            (item for item in assoc.values()
             if item["support"] >= (1 if _IS_EN_WORD2_RE.match(item["word"]) else min_support)),
            key=lambda x: (-x["support"], -x["score"], x["rank"]))
        dropped = 0
        kept: list[str] = []
        for item in located:
            reason = _is_non_info_n2(item["word"], input_set, _noise)
            if reason:
                dropped += 1
                continue
            swow_pool.add(item["word"])
            kept.append(item["word"])
            if len(kept) >= QKV_TOP_CUES:
                break
        return {
            "swowPool": swow_pool,
            "inputCentroid": None,
            "nbPool": None,
            "trace_": {"inputSwowSize": len(swow_pool), "nbDeferred": True,
                       "located": len(located), "kept": kept},
        }

    # ── NB 质心（非延迟路径; nbPool 由 resources_node1 provider 接线, 未接线=None 同 JS 缺席退化）──
    nb_pool = res.get_numberbatch()
    input_vecs = [v for v in (_nb_get(nb_pool, w) for w in input_words) if v is not None]

    def _swow_opts(anchor: str) -> dict[str, Any]:
        # [对照 node2:_swowOpts] distance 门控 opts 工厂; anchor 无向量则 cos 恒 None(只走 rank 过滤)
        av = _nb_get(nb_pool, anchor)
        return {"distance": _N2_DISTANCE,
                "cosToAnchor": (lambda w, _av=av: _cos300(_av, _nb_get(nb_pool, w)))}

    input_centroid = _normalize_centroid(input_vecs)
    _centroid_src = "input"
    _centroid_vec_n = len(input_vecs)
    if input_centroid is None and _P1_CENTROID_FALLBACK:
        # [对照 node2 质心 fallback] 原词无向量时用 SWOW 一跳联想词里有向量的建 proxy 质心
        proxy_vecs = []
        for w in input_words:
            for s in res.swow_diverge(w, SWOW_TOPK, _swow_opts(w)):
                v = s.get("word") and _nb_get(nb_pool, s["word"])
                if v is not None and v is not False:
                    proxy_vecs.append(v)
        if proxy_vecs:
            input_centroid = _normalize_centroid(proxy_vecs)
            _centroid_src = "swowProxy"
            _centroid_vec_n = len(proxy_vecs)

    # ── QKV 池交汇发散（P1 第二段核心）[对照 node2 QKV 块逐行] ──
    conv_cue_count = conv_assoc_count = 0
    n2_diverged_n = n2_dropped_m = 0
    n2_dropped: list[str] = []
    conv_sample: list[str] = []
    if (QKV_MODE != "off" and input_centroid is not None
            and len(input_vecs) >= QKV_MIN_INPUTS and _nb_size(nb_pool) > 0):
        cues = res.load_swow_zh_cues()
        cue_names = list(cues.keys())
        if cue_names:
            input_set = set(input_words)
            # QKV guard: cue 必须与某输入词有 SWOW 直接关联(滤纯通用高频 cue)
            _input_assoc_set: Optional[set[str]] = None
            if _QKV_GUARD:
                _input_assoc_set = set()
                for w in input_words:
                    rs = cues.get(w)
                    if isinstance(rs, list):
                        for r in rs:
                            rw = r if isinstance(r, str) else (r.get("word") if isinstance(r, dict) else None)
                            if rw:
                                _input_assoc_set.add(rw)
            # K: 质心(Q)对所有 SWOW cue 算点积(余弦, Q 与 cue 向量均归一化语义空间)
            cue_sims: list[tuple[str, float]] = []
            for cue in cue_names:
                if cue in input_set:
                    continue
                cv = _nb_get(nb_pool, cue)
                if cv is None:
                    continue
                dot = 0.0
                for i in range(NB_DIM):
                    dot += input_centroid[i] * cv[i]
                if _QKV_GUARD:
                    if cue not in _input_assoc_set:  # type: ignore[operator]
                        continue
                    if dot < QKV_CUE_COS_MIN:
                        continue
                cue_sims.append((cue, dot))
            cue_sims.sort(key=lambda x: -x[1])  # Python 稳定排序 = JS 规范稳定排序
            # top-QKV_TOP_CUES 交汇 cue 注入; 进池前跑节点2出口非信息词排除
            for cue, _dot in cue_sims[:QKV_TOP_CUES]:
                n2_diverged_n += 1
                c_reason = _is_non_info_n2(cue, input_set, _noise)
                if c_reason:
                    n2_dropped_m += 1
                    if len(n2_dropped) < 24:
                        n2_dropped.append(cue + ":" + c_reason)
                else:
                    swow_pool.add(cue)
                    conv_cue_count += 1
                    if len(conv_sample) < 12:
                        conv_sample.append(cue)
                # V: 从交汇 cue 链式再发散(B 模式 centroid_only 跳过)
                if QKV_MODE != "centroid_only":
                    for s in res.swow_diverge(cue, QKV_CUE_ASSOC, _swow_opts(cue)):
                        sw = s.get("word")
                        n2_diverged_n += 1
                        s_reason = _is_non_info_n2(sw, input_set, _noise)
                        if s_reason:
                            n2_dropped_m += 1
                            if len(n2_dropped) < 24:
                                n2_dropped.append(str(sw) + ":" + s_reason)
                        else:
                            swow_pool.add(sw)
                            conv_assoc_count += 1
                            if len(conv_sample) < 12:
                                conv_sample.append(sw)

    # [删 2026-06-03 红线二·禁逐词发散] 与 JS 同: 无逐词兜底, 只 QKV 池交汇空间发散

    return {
        "swowPool": swow_pool,
        "inputCentroid": input_centroid,
        "nbPool": nb_pool,
        "trace_": {"inputSwowSize": len(swow_pool), "convCueCount": conv_cue_count,
                   "convAssocCount": conv_assoc_count, "n2DroppedM": n2_dropped_m,
                   "n2Dropped": n2_dropped},
    }


def get_node2_swow_cache_stats() -> dict[str, Any]:
    """[对照 node2:getNode2SwowCacheStats 口径]"""
    cues_loaded = res._swow_zh_cue_cache is not None  # noqa: SLF001 — 只读状态探针, 对照 JS 同文件直读
    colloq = res._colloquial_noninfo  # noqa: SLF001
    return {
        "loaded": sum(1 for v in (res._swow_zh_cue_cache, colloq) if v is not None),  # noqa: SLF001
        "cueLoaded": cues_loaded,
        "colloquialBuckets": len(colloq) if colloq else 0,
    }


def clear_node2_swow_caches() -> None:
    """[对照 node2:clearNode2SwowCaches]"""
    res.clear_node2_resource_caches()


# ── JS 命名别名 ──
divergeNode2 = diverge_node2
clearNode2SwowCaches = clear_node2_swow_caches
getNode2SwowCacheStats = get_node2_swow_cache_stats
