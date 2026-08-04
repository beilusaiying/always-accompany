"""p1_node0_anchor.py — 节点0: 上下文锚点提取（JS 平移: p1/p1_node0_recall.mjs recallNode0）。

功能链：p1_recall.recall_v2 → recall_node0(sanitized_history, swow_pool, input_centroid, nb_pool,
        is_noise, seen_nodes, pool_map, opts) → {anchors, trace_}
why：P1 的发散要以对话上下文为锚点才不失焦；取最近 N 句用户历史 × SWOW 交集 + NB300 cosine
     提 top 锚词，作发散辅助约束（召回不主导，不投票）。
平移保真（参数全取 JS 现值，env 名同款）：
    CTX_SWOW_HEAD=4 / CTX_SWOW_TOPK=4 / NB_AMP_THRESH=0.15 / NB_AMP_FACTOR=10 / TOP_CTX=4 /
    ANCHOR_MAX=8 / ANCHOR_BCC_DEMOTE=300000 / combinedMin 默认4(configured 优先) / contextCount 默认3
    / P1_N0_SUBSTR 默认on(子串兜底) / P1_N0_INFOW 默认on(IPW 1/sqrt(bccF+1), 零频→0) /
    P1_N0_CONCRETE 默认off(concreteness bonus, S6 决策先关) / strength=(0.3+0.05*min(combined,8))*bccPenalty
跨分身接口（已按分身A 落盘实签对齐 0731 21:50）：
    resources_node1.swow_diverge(word, top_k) -> list[{"word": str, ...}]（JS wordCoords.swowDiverge 平移）
    resources.get_concreteness(word) -> float | None（JS wordCoords.getConcreteness 平移，分身B 侧）
影响范围：纯计算只读，返回 anchors 数组，不写任何文件。
红线：召回不主导——anchors 只作发散锚点；本节点只取用户历史句。
"""
from __future__ import annotations

import math
import os

import numpy as np

try:
    from .p1_whitebox import trace
    from .resources import run_step1_extract, get_bcc_freq, get_concreteness
    from .resources_node1 import swow_diverge  # 分身A SWOW 单源（见文件头）
except ImportError:
    from p1_whitebox import trace
    from resources import run_step1_extract, get_bcc_freq, get_concreteness
    from resources_node1 import swow_diverge  # 分身A SWOW 单源（见文件头）

NB_DIM = 300  # NB300 维度事实(资源属性, 非调优参数)

# S7-4 env 化 9 参数——默认值=JS 现值(行为零变化), 全 [待实验定]
CTX_SWOW_HEAD = float(os.environ.get("P1_N0_SWOW_HEAD") or 4)
CTX_SWOW_TOPK = float(os.environ.get("P1_N0_SWOW_TOPK") or 4)
NB_AMP_THRESH = float(os.environ.get("P1_N0_AMP_THRESH") or 0.15)
NB_AMP_FACTOR = float(os.environ.get("P1_N0_AMP_FACTOR") or 10)
TOP_CTX = int(float(os.environ.get("P1_N0_TOP_CTX") or 4))
ANCHOR_MAX = int(float(os.environ.get("P1_N0_ANCHOR_MAX") or 8))
ANCHOR_BCC_DEMOTE = float(os.environ.get("P1_N0_BCC_DEMOTE") or 300000)


def _fx(x, n):
    return float(f"{float(x):.{n}f}")


def _finite_number(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def recall_node0(chat_history, input_swow, input_centroid, nb_pool, is_noise, seen_nodes,
                 pool_map=None, opts=None):
    """节点0 主函数（纯函数 in→out，字段与 JS 逐一对应）。

    chat_history  — 最近对话历史 [{role, content}]
    input_swow    — 节点2 输入散词池 set
    input_centroid— 输入 NB 质心 (ndarray|None)
    nb_pool       — NB 向量池 dict|None
    is_noise      — 虚词判定 fn
    seen_nodes    — 已处理节点 set
    pool_map      — buildRecallPool 词→{sources,strength} 索引（None 回退 +1 旧行为）
    返回: {"anchors": [...], "trace_": {...}}
    """
    _noise = is_noise if callable(is_noise) else (lambda w: False)
    _seen = seen_nodes if isinstance(seen_nodes, set) else set()
    opts = opts or {}
    config_combined_min = _finite_number(opts.get("combinedMin"))
    combined_min = config_combined_min if config_combined_min is not None \
        else float(os.environ.get("P1_N0_COMBINED_MIN") or 4)
    anchors = []
    configured_context_count = _finite_number(opts.get("contextMessages"))
    context_count = max(0, min(5, int(configured_context_count))) \
        if configured_context_count is not None else 3

    # ── Step 4: 取最近 N 句用户上下文 ──
    ctx_sentences = []
    if isinstance(chat_history, list):
        user_history = [m for m in chat_history if isinstance(m, dict) and m.get("role") == "user"]
        selected_history = user_history[-context_count:] if context_count > 0 else []
        for m in selected_history:
            content = (m.get("content") or "")
            if isinstance(content, str) and content.strip():
                ctx_sentences.append(content.strip())

    trace("node0", lambda: {
        "input": {"ctxSentences": len(ctx_sentences), "contextCount": context_count,
                  "inputSwowSize": len(input_swow) if input_swow is not None else 0,
                  "hasCentroid": input_centroid is not None},
        "process": "N句上下文 → 逐句SWOW交集+NB cosine 打分 → top句提关键词作召回锚点(召回不主导, 作发散锚点)",
        "reason": "照搬现有上下文召回逻辑(来自重构前旧 p1_recall monolith); 召回data不读, 只读上下文句",
    })

    # ── Step 5: 逐句打分(SWOW交集 + NB cosine) ──
    scored_ctx = []
    substr_on = os.environ.get("P1_N0_SUBSTR") != "off"
    input_centroid64 = np.asarray(input_centroid, dtype=np.float64) if input_centroid is not None else None
    for sent in ctx_sentences:
        ctx_words = [w for w in (run_step1_extract(sent).get("words") or [])
                     if len(w) >= 2 and not _noise(w)]
        if not ctx_words:
            continue

        ctx_swow = set(ctx_words)
        for w in ctx_words[:int(CTX_SWOW_HEAD)]:
            for s in (swow_diverge(w, int(CTX_SWOW_TOPK)) or []):
                sw = s.get("word") if isinstance(s, dict) else None
                if sw and len(sw) >= 2 and not _noise(sw):
                    ctx_swow.add(sw)

        # S5: 交集分 = poolMap.strength(池来源加权) / 无 poolMap 回退 +1
        swow_score = 0.0
        if input_swow:
            for w in input_swow:
                if w in ctx_swow:
                    if pool_map is not None and w in pool_map:
                        swow_score += pool_map[w].get("strength", 1)
                    else:
                        swow_score += 1

        # 子串兜底: len>=2 池词未被交集命中但原文子串含 → 计入(单字排除防误命中爆炸)
        substr_hits = 0
        if substr_on and input_swow:
            for w in input_swow:
                if isinstance(w, str) and len(w) >= 2 and w not in ctx_swow and w in sent:
                    substr_hits += 1
            swow_score += substr_hits

        nb_score = 0.0
        if input_centroid64 is not None and nb_pool:
            ctx_vecs = [nb_pool.get(w) for w in ctx_words]
            ctx_vecs = [v for v in ctx_vecs if v is not None]
            if ctx_vecs:
                # JS Float32Array 累加语义: 逐步 f32 存回
                ctx_cent = np.zeros(NB_DIM, dtype=np.float32)
                for v in ctx_vecs:
                    ctx_cent += np.asarray(v, dtype=np.float32)
                ctx_cent /= np.float32(len(ctx_vecs))
                cn = float(np.sum(ctx_cent.astype(np.float64) ** 2))
                cn = math.sqrt(cn) or 1.0
                ctx_cent = (ctx_cent.astype(np.float64) / cn).astype(np.float32)
                nb_score = float(input_centroid64 @ ctx_cent.astype(np.float64))

        combined = swow_score + (nb_score * NB_AMP_FACTOR if nb_score > NB_AMP_THRESH else 0.0)
        if combined >= combined_min:
            scored_ctx.append({"sent": sent, "ctxWords": ctx_words, "swowScore": swow_score,
                               "substrHits": substr_hits, "nbScore": nb_score, "combined": combined})

    # ── Step 6: 提取锚点 — 词级信息量排序(R4修复: rank = combined + infoW + concBonus 加性) ──
    scored_ctx.sort(key=lambda s: -s["combined"])  # stable, 同 JS
    infow_on = os.environ.get("P1_N0_INFOW") != "off"
    conc_on = os.environ.get("P1_N0_CONCRETE") == "on"  # 默认off(S6决策: concreteness bias 先关)
    conc_w = float(os.environ.get("P1_N0_CONCRETE_W") or 0.5)  # [待实验定]
    cand = []
    cand_words = set()
    for sc in scored_ctx[:TOP_CTX]:
        for w in sc["ctxWords"]:
            if w in _seen or w in cand_words:
                continue
            bcc_f = get_bcc_freq(w)
            # IPW 逆倾向加权: 1/sqrt(bccF+1); 零频→0(加法零元, BCC未收录=信息未知)
            info_w = 1 / math.sqrt(bcc_f + 1) if bcc_f > 0 else 0.0
            _conc = get_concreteness(w)
            conc_bonus = ((5 - _conc) / 4) * conc_w if (conc_on and _conc is not None) else 0.0
            cand.append({"node": w, "bccF": bcc_f, "infoW": info_w, "_conc": _conc,
                         "concBonus": conc_bonus, "sc": sc,
                         "rank": sc["combined"] + (info_w if infow_on else 0.0) + conc_bonus})
            cand_words.add(w)
    if infow_on:
        cand.sort(key=lambda c: -c["rank"])  # off=保持句序=旧行为
    for c in cand[:ANCHOR_MAX]:
        bcc_penalty = 0.05 if c["bccF"] > ANCHOR_BCC_DEMOTE else 1.0  # 铁律#48: 硬过滤→软降权
        anchors.append({
            "node": c["node"],
            "strength": (0.3 + 0.05 * min(c["sc"]["combined"], 8)) * bcc_penalty,
            "_combined": c["sc"]["combined"],
            "_nbCos": c["sc"]["nbScore"],
            "_infoW": _fx(c["infoW"], 3),
            "_conc": _fx(c["_conc"], 2) if c["_conc"] is not None else None,
            "_concBonus": _fx(c["concBonus"], 2),
        })

    trace_ = {
        "combinedMin": combined_min,
        "contextCount": context_count,
        "ctxSentences": len(ctx_sentences),
        "scoredCtx": [{
            "sent": s["sent"][:30],
            "swow": s["swowScore"],
            "substr": s.get("substrHits") or 0,
            "nb": _fx(s["nbScore"], 3),
            "combined": _fx(s["combined"], 1),
        } for s in scored_ctx[:TOP_CTX]],
        "anchors": [a["node"] for a in anchors[:5]],
    }

    trace("node0", lambda: {"output": {"anchorCount": len(anchors), "anchors": [a["node"] for a in anchors]}})

    return {"anchors": anchors, "trace_": trace_}
