"""p1_node8_10_blq.py — BLQ 多维打分算子（JS 平移: p1/p1_node8_10_blq.mjs 的 calcBLQ 段）。

范围说明（召回层平移，分身B 0731）：
    召回链（recallOnly）只消费 calcBLQ —— p1_node0_data_recall 对每个稀疏候选算 blqScore/annot
    （blqRerank 默认 False 时只进白盒不进排序）。节点8 精排 refineInfoWords / 节点10 红线
    refineDirectionWords / isRedlineWord 属发散侧（node3-10），recallOnly 早退链不触达，未平移
    ——待发散侧平移任务另立（勿据本文件误判"BLQ 只有 calcBLQ"）。

平移保真：CFG 数值逐项照抄 JS CFG；抑制维聚合=加性扣分（additive − Σpenalty，软地板
    BLQ_SUPPRESS_FLOOR），P1_NODE8_BLQ_SUPPRESS=mult 复现 legacy 连乘（JS 同款开关）。
关联链：← p1_node0_data_recall.py（calc_blq）；→ p1_whitebox.trace（blq / blq:channels 白盒）
影响范围：纯计算；overused 名单在 calcBLQ 路径与 JS 同款"未显式加载则不惩罚"。
"""
from __future__ import annotations

import math
import os

try:
    from .p1_whitebox import trace
except ImportError:
    from p1_whitebox import trace

# "add"(默认加性) | "mult"(legacy连乘) —— 与 JS _P1_NODE8_BLQ_SUPPRESS 同款
_P1_NODE8_BLQ_SUPPRESS = (os.environ.get("P1_NODE8_BLQ_SUPPRESS") or "add").strip().lower()

CFG = {
    "BM25_K1": 1.5,
    "BM25_B": 0.75,
    "W_SPATIAL": 1.0,
    "W_TF": 0.6,
    "W_PATH": 0.4,
    "W_NB": 0.5,
    "W_SPEC": 0.4,
    "W_CONFIRM": 0.3,
    "ISOLATED_NOISE_PEN": 0.5,
    "BLQ_SUPPRESS_FLOOR": 0.1,
    "OVERUSED_PENALTY": 0.35,
    "POLARITY_MISMATCH": 0.3,
    "NB_IRRELEVANT_COS": 0.05,
    "NB_IRRELEVANT_PEN": 0.15,
}

_overused_set: set[str] | None = None


def build_overused_set(overused_list) -> set[str]:
    global _overused_set
    if isinstance(overused_list, set):
        _overused_set = overused_list
        return _overused_set
    _overused_set = set()
    if isinstance(overused_list, list):
        for s in overused_list:
            if isinstance(s, str) and s:
                _overused_set.add(s)
    return _overused_set


def get_node8_blq_cache_stats() -> dict:
    return {"loaded": _overused_set is not None, "buckets": len(_overused_set) if _overused_set else 0}


def clear_node8_blq_caches() -> None:
    global _overused_set
    _overused_set = None


def _is_overused(term: str, ovr_set) -> bool:
    s = ovr_set if ovr_set is not None else _overused_set
    return bool(s and term in s)


def _cos300(a, b):
    if a is None or b is None:
        return None
    n = min(len(a), len(b))
    dot = na = nb = 0.0
    for i in range(n):
        x = float(a[i])
        y = float(b[i])
        dot += x * y
        na += x * x
        nb += y * y
    d = math.sqrt(na) * math.sqrt(nb)
    return dot / d if d > 0 else 0.0


def _term_vec(term, meta, nb):
    """term NB300 向量解析（带 nb_proxy 回退，同 JS _termVec）。"""
    if nb is None:
        return None
    v = nb.get(term) if hasattr(nb, "get") else None
    if v is not None:
        return v
    px = (meta or {}).get("nb_proxy") if isinstance(meta, dict) else None
    if not isinstance(px, list) or not px:
        return None
    pv = []
    for w in px:
        wv = nb.get(w)
        if wv is not None:
            pv.append(wv)
    if not pv:
        return None
    dims = len(pv[0])
    avg = [0.0] * dims
    for wv in pv:
        for i in range(dims):
            avg[i] += float(wv[i])
    n = 0.0
    for i in range(dims):
        avg[i] /= len(pv)
        n += avg[i] ** 2
    n = math.sqrt(n) or 1.0
    for i in range(dims):
        avg[i] /= n
    return avg


def _bm25_tf(f, k1=CFG["BM25_K1"], b=CFG["BM25_B"]):
    """BM25 TF 饱和: 本场景 dl/avgdl=1 → f/(f+k1)。"""
    if not f or f <= 0:
        return 0.0
    return f / (f + k1 * (1 - b + b))


def _fx(x, n):
    """JS `+v.toFixed(n)` 等价。"""
    return float(f"{float(x):.{n}f}")


def calc_blq(cand: dict, ctx: dict | None = None) -> dict:
    """BLQ 算子 — 打分装置（多维标注 + 加权 CombSUM − Σ抑制扣分，不全乘积/不取均值）。

    cand: {term, score?, _voteCount?, _pathSupport?, _nbCos?, _overused?, meta?, axis?}
    ctx : {nb, inputCentroid, overusedSet?, polarity?, consumeConfirm?, specificity?, disciplineCount?}
    返回: {"blqScore": float, "annot": dict}
    """
    ctx = ctx or {}
    nb = ctx.get("nb")
    input_centroid = ctx.get("inputCentroid")
    overused_set = ctx.get("overusedSet")
    polarity = ctx.get("polarity", "neutral")
    consume_confirm = ctx.get("consumeConfirm", False)
    term = cand.get("term")

    # 维1 空间: tanh(rawScore) 压[0,1)饱和
    raw_score = cand.get("score")
    if raw_score is None:
        raw_score = cand.get("_totalVote")
    if raw_score is None:
        raw_score = 0.5
    d_spatial = math.tanh(raw_score)

    # 维2 BM25 TF
    tf = cand.get("_voteCount")
    if tf is None:
        tf = cand.get("_pathSupport")
    if tf is None:
        tf = 1
    d_tf = _bm25_tf(tf)

    # 维3 pathHarmony（跨学科数，只计 1 次）
    disc = 1
    discipline_count = ctx.get("disciplineCount")
    if callable(discipline_count):
        disc = discipline_count(term) or 1
    elif cand.get("_pathSupport"):
        disc = cand["_pathSupport"]
    d_path = math.log(1 + disc) / math.log(1 + 6)

    # 维4 NB 相关性
    nb_cos = cand.get("_nbCos", None)
    if nb_cos is None and nb is not None and input_centroid is not None:
        v = _term_vec(term, cand.get("meta"), nb)
        if v is not None:
            nb_cos = _cos300(v, input_centroid)
    d_nb = max(0.0, nb_cos) if nb_cos is not None else 0.3  # 无 NB → 中性 0.3

    # 维5 specificity
    specificity = ctx.get("specificity")
    if callable(specificity):
        spec = specificity(term)
        if spec is None:
            spec = 0.5
    else:
        spec = min(1.0, (len(term) if term else 2) / 6)
    d_spec = spec

    # 维6 资源确认（consumeConfirm 门控，召回链恒 False → 零贡献）
    confirm_count = (cand.get("confirmCount") or 0) if consume_confirm else 0
    d_confirm = math.log(1 + confirm_count) / math.log(1 + 6) if confirm_count > 0 else 0.0

    additive = (
        CFG["W_SPATIAL"] * d_spatial
        + CFG["W_TF"] * d_tf
        + CFG["W_PATH"] * d_path
        + CFG["W_NB"] * d_nb
        + CFG["W_SPEC"] * d_spec
        + CFG["W_CONFIRM"] * d_confirm
    )

    # ── 抑制维（各仅一处）──
    m_overused = CFG["OVERUSED_PENALTY"] if (_is_overused(term, overused_set) or cand.get("_overused")) else 1.0
    m_polarity = 1.0
    if polarity != "neutral":
        tv = (cand.get("meta") or {}).get("valence") if isinstance(cand.get("meta"), dict) else None
        pol = None
        if tv is not None:
            pol = "positive" if tv >= 0.5 else "negative"
        if pol is None:
            # JS: try { inferSubwordPolarity } catch { null } —— 召回链 polarity 恒 neutral 不达此分支;
            # 发散侧词库(wordCoords)未平移时按 JS catch 语义收敛为 null
            try:
                try:
                    from .p1_node2_swow import infer_subword_polarity  # type: ignore
                except ImportError:
                    from p1_node2_swow import infer_subword_polarity  # type: ignore
                pol = infer_subword_polarity(term)
            except Exception:
                pol = None
        if pol and pol != "neutral" and pol != polarity:
            m_polarity = CFG["POLARITY_MISMATCH"]
    m_nb_irrelevant = CFG["NB_IRRELEVANT_PEN"] if (nb_cos is not None and nb_cos < CFG["NB_IRRELEVANT_COS"]) else 1.0
    m_isolated_noise = CFG["ISOLATED_NOISE_PEN"] if (consume_confirm and confirm_count == 0) else 1.0

    pen_overused = additive * (1 - m_overused)
    pen_polarity = additive * (1 - m_polarity)
    pen_nb_irrelevant = additive * (1 - m_nb_irrelevant)
    pen_isolated_noise = additive * (1 - m_isolated_noise)
    penalty_sum = pen_overused + pen_polarity + pen_nb_irrelevant + pen_isolated_noise
    if _P1_NODE8_BLQ_SUPPRESS == "mult":
        # legacy 连乘（仅 A/B 对照，JS 同款开关；默认不走）
        blq_score = additive * m_overused * m_polarity * m_nb_irrelevant * m_isolated_noise
    else:
        blq_score = max(additive * CFG["BLQ_SUPPRESS_FLOOR"], additive - penalty_sum)

    annot = {
        "dSpatial": _fx(d_spatial, 3), "dTf": _fx(d_tf, 3), "dPath": _fx(d_path, 3),
        "dNb": _fx(d_nb, 3), "dSpec": _fx(d_spec, 3), "dConfirm": _fx(d_confirm, 3),
        "mOverused": m_overused, "mPolarity": m_polarity,
        "mNbIrrelevant": m_nb_irrelevant, "mIsolatedNoise": m_isolated_noise,
        "penOverused": _fx(pen_overused, 3), "penPolarity": _fx(pen_polarity, 3),
        "penNbIrrelevant": _fx(pen_nb_irrelevant, 3), "penIsolatedNoise": _fx(pen_isolated_noise, 3),
        "penaltySum": _fx(penalty_sum, 3),
        "additive": _fx(additive, 3), "blqScore": _fx(blq_score, 4),
        "tf": tf, "nbCos": _fx(nb_cos, 3) if nb_cos is not None else None,
        "confirmCount": confirm_count,
    }

    trace("blq", lambda: {
        "input": {"term": term, "axis": cand.get("axis"), "rawScore": _fx(raw_score, 3)},
        "process": "多维标注(空间/BM25-TF饱和/pathHarmony一处/NB/spec/资源确认)加权CombSUM − Σ抑制扣分(万金油/极性/无关/孤立噪声各一处). 不全乘积不取均值.",
        "output": {"blqScore": _fx(blq_score, 4), "annot": annot},
        "reason": (
            f"additive={annot['additive']} − Σpenalty({penalty_sum:.3f}"
            f"=overused{pen_overused:.2f}+polarity{pen_polarity:.2f}+nbIrrel{pen_nb_irrelevant:.2f}"
            f"+isolated{pen_isolated_noise:.2f})={blq_score:.3f}; "
            "加性扣分单门等价旧连乘多门不指数坍缩; pathHarmony仅计1次(修DC-2)"
        ),
    })

    trace("blq:channels", lambda: {
        "input": {"term": term, "axis": cand.get("axis"), "rawScore": _fx(raw_score, 3), "tf": tf,
                  "nbCos": _fx(nb_cos, 3) if nb_cos is not None else None, "confirmCount": confirm_count},
        "combSumChannels": {
            "ch1 空间dSpatial": {"raw": _fx(d_spatial, 3), "weight": CFG["W_SPATIAL"],
                                "contrib": _fx(CFG["W_SPATIAL"] * d_spatial, 3), "note": "tanh(rawScore)压[0,1)饱和"},
            "ch2 BM25-TF dTf": {"raw": _fx(d_tf, 3), "weight": CFG["W_TF"],
                                "contrib": _fx(CFG["W_TF"] * d_tf, 3),
                                "note": f"f={tf}→f/(f+k1={CFG['BM25_K1']}) 票数饱和防碾压"},
            "ch3 pathHarmony dPath": {"raw": _fx(d_path, 3), "weight": CFG["W_PATH"],
                                      "contrib": _fx(CFG["W_PATH"] * d_path, 3),
                                      "note": f"disc={disc} log(1+disc)/log(7) 只计1次(修DC-2)"},
            "ch4 NB相关 dNb": {"raw": _fx(d_nb, 3), "weight": CFG["W_NB"],
                              "contrib": _fx(CFG["W_NB"] * d_nb, 3),
                              "note": "max(0,cos↔输入质心)" if nb_cos is not None else "无NB→中性0.3"},
            "ch5 specificity dSpec": {"raw": _fx(d_spec, 3), "weight": CFG["W_SPEC"],
                                      "contrib": _fx(CFG["W_SPEC"] * d_spec, 3),
                                      "note": "ctx注入" if callable(specificity) else "词长粗估min(1,len/6)"},
            "ch6 资源确认dConfirm": {"raw": _fx(d_confirm, 3), "weight": CFG["W_CONFIRM"],
                                     "contrib": _fx(CFG["W_CONFIRM"] * d_confirm, 3),
                                     "note": f"confirmCount={confirm_count} log(1+cc)/log(7)" if consume_confirm else "consumeConfirm=false→中性0"},
        },
        "additive": _fx(additive, 3),
        "suppressPenalties": {
            "万金油overused": {"factor": m_overused, "penalty": _fx(pen_overused, 3), "fired": m_overused < 1,
                              "reason": "命中overused名单或cand._overused" if m_overused < 1 else "未命中"},
            "极性polarity": {"factor": m_polarity, "penalty": _fx(pen_polarity, 3), "fired": m_polarity < 1,
                            "reason": "候选极性≠输入极性" if m_polarity < 1 else "匹配或中性"},
            "无关nbIrrelevant": {"factor": m_nb_irrelevant, "penalty": _fx(pen_nb_irrelevant, 3),
                                "fired": m_nb_irrelevant < 1,
                                "reason": f"nbCos<{CFG['NB_IRRELEVANT_COS']}=无关" if m_nb_irrelevant < 1 else "相关或无NB"},
            "孤立噪声isolatedNoise": {"factor": m_isolated_noise, "penalty": _fx(pen_isolated_noise, 3),
                                     "fired": m_isolated_noise < 1,
                                     "reason": ("confirmCount=0=无资源确认=孤立噪声" if m_isolated_noise < 1
                                                else ("confirmCount>0=有资源确认" if consume_confirm
                                                      else "consumeConfirm=false→不启用"))},
        },
        "penaltySum": _fx(penalty_sum, 3),
        "output": {
            "blqScore": _fx(blq_score, 4),
            "formulaAdd": f"{additive:.3f} − Σpenalty({penalty_sum:.3f}) = {blq_score:.3f}",
        },
        "reason": "CombSUM=加权线性和(非连乘); 抑制维加性扣分(additive−Σpenalty, 各只一处); ch6资源确认=节点5 confirmCount消费(P1_NODE5_CONSUME门控)",
    })

    return {"blqScore": blq_score, "annot": annot}
