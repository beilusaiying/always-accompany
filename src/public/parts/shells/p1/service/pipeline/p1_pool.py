# ════════════════════════════════════════════════════════════════════
# p1_pool.py — 召回侧多路发散池（四+1 路由 → 合并单源收口）
# [JS 平移真身: src/yonban/core/functions/memory/p1/p1_pool.mjs, 2026-07-31 定档态]
#
# 功能链：p1_pipeline.py(主AI织合) → build_recall_pool(ctx) → {swowPool, poolMap, trace}
#         → node0 消费（swowPool 被非 swow 路新词扩池, 下游零改动自然消费）
# why：002 打回"召回完全做错"——名称组合+SWOW+NB300+mode资源多路发散合并到一个池统一打分
#      （凛倾"汇总到一个池,不是相乘,而是空间"）。本文件=池的单源收口。
# ctx 形状（dict, 对照 JS ctx 对象逐键）：
#   inputText / inputWords / swowPool(OrderedSet) / nbPool / inputCentroid / mode / recallConfig
# 关联链：
#   → resources_node1.py（MEMORY_DIR/USER_VOCAB_DIR/env 助手/OrderedSet）
#   → route1 names: character_psychology.json（152角色×~8别名; ASCII key \b 词边界 0731 断点④修复）
#   → route2 swow: p1_node2_swow.py diverge_node2 产出的登记（不重复计算）
#   → route3 nb300: 质心kNN+Goldilocks ibFactor（默认 disabledByConfig, 全表扫 opt-in）
#   → route4 modeRes: cn(conceptnet倒排, REL_WEIGHTS 含 0731 英文 Synonym/IsA=0.3 定档) /
#                     sm(sensorimotor 同感官通道) / cfn(CFN-Lex 语义框架) / user(插拔词库 30s TTL)
# 红线：conceptnet 禁 IsA/Synonym/Antonym 高权(run23 -55%)——REL_WEIGHTS<0.1 自动过滤保持；
#      英文候选例外走 _EN_RELW=0.3（0731 A/B 三档同词集定档取中间档, 中文行为零变化实证）。
# ════════════════════════════════════════════════════════════════════
from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any, Optional

try:
    from . import resources_node1 as res
except ImportError:  # 独立脚本运行时退化为平级 import
    import resources_node1 as res

# ── 路1: 名称组合 [对照 p1_pool.mjs:_getNamesIndex/routeNames] ──
_names_idx: Optional[dict[str, dict[str, Any]]] = None
_names_err: Optional[str] = None


def _get_names_index() -> Optional[dict[str, dict[str, Any]]]:
    """索引: lowercase(名称/别名) → {canonical, expand}; 懒加载+响亮失败(_namesErr 进 trace 不吞)。"""
    global _names_idx, _names_err
    if _names_idx is not None or _names_err is not None:
        return _names_idx
    try:
        j = json.loads((res.MEMORY_DIR / "character_psychology.json").read_text(encoding="utf-8-sig"))
        _names_idx = {}
        for canonical, data in (j.get("characters") or {}).items():
            expand = [canonical, *(data.get("aliases") or [])]
            for name in expand:
                key = str(name).lower()
                # 单字键(焰/圆等)不进索引: 子串误命中率高, 先保精度
                if len(key) >= 2 and key not in _names_idx:
                    _names_idx[key] = {"canonical": canonical, "expand": expand}
    except (OSError, json.JSONDecodeError, AttributeError) as e:
        _names_err = str(e)[:120]
    return _names_idx


_ASCII_KEY_RE = re.compile(r"^[a-z0-9_-]+$")


def route_names(ctx: dict[str, Any]) -> dict[str, Any]:
    idx = _get_names_index()
    if idx is None:
        return {"words": [], "trace": {"route": "names", "status": "dataMissing:" + str(_names_err), "count": 0}}
    input_words = ctx.get("inputWords") or []
    own = set(input_words)
    out = res.OrderedSet()
    done_canonical: set[str] = set()
    matched: list[str] = []

    def expand_hit(e: dict[str, Any], tag: str) -> None:
        if e["canonical"] in done_canonical:
            return
        done_canonical.add(e["canonical"])
        matched.append(tag + "→" + e["canonical"])
        for x in e["expand"]:
            if x not in own:
                out.add(x)

    # 步1: inputWords 命中索引
    for w in input_words:
        e = idx.get(str(w).lower())
        if e:
            expand_hit(e, w)
    # 步2: rawText 子串兜底（救 jieba 碎裂: "小圆"被拆成"小/圆", 原文子串仍可命中）
    # [0731 英文断点④修复] 纯英文/数字别名 key 必须按 \b 词边界匹配（"websocket"→"bs" 假阳性）；
    #   中文 key 无词边界概念保持 in 子串原语义零回归。
    raw = str(ctx.get("inputText") or "").lower()
    if raw:
        for key, e in idx.items():
            if e["canonical"] in done_canonical:
                continue
            if _ASCII_KEY_RE.match(key):
                hit = re.search(r"\b" + re.escape(key) + r"\b", raw) is not None
            else:
                hit = key in raw
            if hit:
                expand_hit(e, "raw:" + key)
    words = [{"word": w, "source": "names", "strength": 1.0} for w in out]
    return {"words": words, "trace": {"route": "names", "status": "active", "count": len(words),
                                      "matched": matched[:10]}}


# ── 路2: SWOW QKV（diverge_node2 产出的登记, 不重复计算）[对照 p1_pool.mjs:routeSwow] ──
def route_swow(ctx: dict[str, Any]) -> dict[str, Any]:
    pool = ctx.get("swowPool")
    words = []
    if pool is not None:
        try:
            for w in pool:  # OrderedSet/set/list 均可迭代（JS 检查 forEach, 此处鸭子类型等价）
                words.append({"word": w, "source": "swow", "strength": 1.0})
        except TypeError:
            pass
    return {"words": words, "trace": {"route": "swow", "status": "active", "count": len(words)}}


# ── 路3: NB300 独立近邻（Goldilocks ibFactor, 默认 disabledByConfig）[对照 p1_pool.mjs:routeNb300] ──
# ★S7-4: Goldilocks 参数 env 化——默认值=补充卷 L96 现值 [对照 p1_pool.mjs:_NB_* 常量块]
_NB_FLOOR = res.env_num_or("P1_NB_FLOOR", 0.15)
_NB_NEAR = res.env_num_or("P1_NB_NEAR", 0.25)
_NB_FAR_LO = res.env_num_or("P1_NB_FAR_LO", 0.70)
_NB_FAR_HI = res.env_num_or("P1_NB_FAR_HI", 0.80)
_NB_IB_NEAR = res.env_num_or("P1_NB_IB_NEAR", 0.7)
_NB_IB_FARLO = res.env_num_or("P1_NB_IB_FARLO", 0.8)
_NB_IB_FARHI = res.env_num_or("P1_NB_IB_FARHI", 0.5)


def route_nb300(ctx: dict[str, Any]) -> dict[str, Any]:
    # 64 万词全表近邻不是召回默认能力；只有实验调用显式 opt-in 才运行（漏传/拼错一律关闭）
    if (ctx.get("recallConfig") or {}).get("nbGlobalRoute") is not True:
        return {"words": [], "trace": {"route": "nb300", "status": "disabledByConfig",
                                       "count": 0, "scanned": 0, "ms": 0}}
    centroid = ctx.get("inputCentroid")   # 300维, 已归一化
    pool = ctx.get("nbPool")              # {word: 300维向量}, 未归一化
    if centroid is None or pool is None or len(pool) == 0:
        return {"words": [], "trace": {"route": "nb300",
                                       "status": "poolEmpty" if centroid is not None else "noCentroid",
                                       "count": 0}}
    import math
    k = int(res.env_num_or("P1_N2B_TOPK", 15))  # [待实验定]
    own = set(ctx.get("inputWords") or [])
    swow = ctx.get("swowPool")
    t0 = time.time()
    cands: list[dict[str, Any]] = []
    items = pool.items() if hasattr(pool, "items") else pool
    for w, vec in items:
        if w in own:
            continue
        if swow is not None and w in swow:
            continue
        dot = norm2 = 0.0
        for i in range(len(vec)):
            dot += centroid[i] * vec[i]
            norm2 += vec[i] * vec[i]
        norm = math.sqrt(norm2)
        if norm == 0:
            continue
        cos = dot / norm
        if cos < _NB_FLOOR:
            continue  # 极低区仍截断(cos<0.15≈随机噪声)
        # Goldilocks ibFactor（补充卷 L96 逐字照抄; 太近/太远软降权非硬过滤=铁律#48）
        ib = 1.0
        if cos < _NB_NEAR:
            ib = _NB_IB_NEAR
        elif cos > _NB_FAR_HI:
            ib = _NB_IB_FARHI
        elif cos > _NB_FAR_LO:
            ib = _NB_IB_FARLO
        cands.append({"word": w, "cos": cos, "ib": ib})
    cands.sort(key=lambda c: -(c["cos"] * c["ib"]))  # 排序按 cos×ibFactor
    top = cands[:k]
    return {
        "words": [{"word": c["word"], "source": "nb300", "strength": round(c["cos"] * c["ib"], 4)} for c in top],
        "trace": {
            "route": "nb300", "status": "active", "count": len(top), "scanned": len(pool),
            "cosRange": [round(top[-1]["cos"], 3), round(top[0]["cos"], 3)] if top else [],
            "ibRange": [round(top[-1]["ib"], 1), round(top[0]["ib"], 1)] if top else [],
            "ms": int((time.time() - t0) * 1000),
        },
    }


# ── 路4 数据源懒加载 [对照 p1_pool.mjs:_getCN/_getSM/_getCfnData] ──
_cn_data: Optional[dict[str, Any]] = None
_cn_err: Optional[str] = None


def _get_cn() -> Optional[dict[str, Any]]:
    global _cn_data, _cn_err
    if _cn_data is not None or _cn_err is not None:
        return _cn_data
    try:
        _cn_data = json.loads((res.MEMORY_DIR / "conceptnet_inverted_simplified.json").read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as e:
        _cn_err = str(e)[:120]
    return _cn_data


_sm_data: Optional[dict[str, Any]] = None
_sm_err: Optional[str] = None
_sm_by_modality: Optional[dict[str, list[dict[str, Any]]]] = None


def _get_sm() -> Optional[dict[str, Any]]:
    global _sm_data, _sm_err, _sm_by_modality
    if _sm_data is not None or _sm_err is not None:
        return _sm_data
    try:
        _sm_data = json.loads((res.MEMORY_DIR / "sensorimotor_zh.json").read_text(encoding="utf-8-sig"))
        # 按 dominant_modality 分桶: 同通道词查找 O(1); 每桶按主通道分数降序（Python 稳定排序=JS）
        _sm_by_modality = {}
        for w, d in _sm_data.items():
            mod = d.get("dominant_modality") or "unknown"
            score = d.get(mod) or 0
            _sm_by_modality.setdefault(mod, []).append({"word": w, "score": score})
        for arr in _sm_by_modality.values():
            arr.sort(key=lambda x: -(x["score"] or 0))
    except (OSError, json.JSONDecodeError, AttributeError) as e:
        _sm_err = str(e)[:120]
    return _sm_data


_cfn_fwd: Optional[dict[str, Any]] = None
_cfn_rev: Optional[dict[str, list[str]]] = None
_cfn_err: Optional[str] = None


def _get_cfn_data() -> Optional[dict[str, Any]]:
    global _cfn_fwd, _cfn_rev, _cfn_err
    if _cfn_fwd is not None or _cfn_err is not None:
        return {"forward": _cfn_fwd, "reverse": _cfn_rev} if _cfn_fwd is not None else None
    try:
        _cfn_fwd = json.loads((res.MEMORY_DIR / "p1_res" / "CFN-Lex" / "CFN_LEX_CN.json").read_text(encoding="utf-8-sig"))
        _cfn_rev = {}
        for frame, words in _cfn_fwd.items():
            if not isinstance(words, list):
                continue
            for w in words:
                _cfn_rev.setdefault(w, []).append(frame)
    except (OSError, json.JSONDecodeError, AttributeError) as e:
        _cfn_err = str(e)[:120]
    return {"forward": _cfn_fwd, "reverse": _cfn_rev} if _cfn_fwd is not None else None


# ── 用户插拔词库（30s TTL 重扫; enabled 单源在文件内, 盘为真相）[对照 p1_pool.mjs:_getUserVocab] ──
_user_vocab_cache: Optional[list[dict[str, Any]]] = None
_user_vocab_scan_at = 0.0


def _get_user_vocab() -> list[dict[str, Any]]:
    global _user_vocab_cache, _user_vocab_scan_at
    now = time.time()
    if _user_vocab_cache is not None and now - _user_vocab_scan_at < 30.0:
        return _user_vocab_cache
    _user_vocab_scan_at = now
    out: list[dict[str, Any]] = []
    try:
        _vocab_dir = res.get_user_vocab_dir()  # 0731 读写同源：与服务 saveUserVocab 同一 config.vocabDir
        for f in os.listdir(_vocab_dir):
            if not f.endswith(".json"):
                continue
            try:
                j = json.loads((_vocab_dir / f).read_text(encoding="utf-8-sig"))
                meta = (j or {}).get("_meta") or {}
                if meta.get("enabled") is False:
                    continue  # 未启用=插拔状态 off
                entries = (j or {}).get("entries")
                if not isinstance(entries, dict):
                    continue
                modes = meta.get("modes")
                modes = modes if (isinstance(modes, list) and modes) else ["all"]
                out.append({"name": meta.get("name") or f, "file": f, "modes": modes, "dict": entries})
            except (OSError, json.JSONDecodeError, AttributeError):
                continue  # 单文件损坏跳过, 不影响其他词库
    except OSError:
        pass  # vocab 目录不存在=用户未用此功能, 合法路径
    _user_vocab_cache = out
    return out


# ── REL_WEIGHTS [对照 p1_pool.mjs:REL_WEIGHTS + P1_REL_W_JSON env 覆盖] ──
_rel_override: dict[str, Any] = {}
try:
    if os.environ.get("P1_REL_W_JSON"):
        _rel_override = json.loads(os.environ["P1_REL_W_JSON"])
except json.JSONDecodeError as e:
    print(f"[p1_pool] P1_REL_W_JSON parse failed, using defaults: {e}", file=sys.stderr)
REL_WEIGHTS: dict[str, float] = {
    # 有09专项出处(5种): Causes/HasProperty/RelatedTo/Synonym/Antonym(run23 -55%铁证)
    "Causes": 0.9, "HasProperty": 0.5, "RelatedTo": 0.1, "Synonym": 0.05, "Antonym": 0.01,
    # [按语义因果性梯度 待实验定](7种)
    "MotivatedByGoal": 0.8, "CapableOf": 0.7, "UsedFor": 0.6,
    "HasSubevent": 0.5, "CausesDesire": 0.5, "AtLocation": 0.4,
    "HasA": 0.3, "PartOf": 0.3,
    # relWeight<0.1 自动过滤=Synonym(0.05)/IsA(0.05)/Antonym(0.01)→run23 红线保持
    "IsA": 0.05,
}
REL_WEIGHTS.update(_rel_override)  # env 覆盖合并(空对象=零回归)

# ★[0731 A/B 定档] 英文专属权重覆盖: 英文技术词正确义项恰走 IsA/Synonym(被<0.1阈值拦死)
#   → per-target 英文候选(源词或目标词纯英文)时 relW 换 _EN_RELW=0.3（中间档, 中文行为零变化实证）
#   [对照 p1_pool.mjs:_EN_WORD_RE/_EN_RELW/_EN_REL_OVERRIDE_KEYS]
_EN_WORD_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")
_EN_RELW_RAW = os.environ.get("P1_POOL_EN_RELW")
_EN_RELW: float = 0.3  # [0731 A/B 定档默认值] env 未设时即生效（已由 A/B 证明中文/角色卡零回归）
if _EN_RELW_RAW is not None:
    try:
        _EN_RELW = float(_EN_RELW_RAW)
    except ValueError:
        print(f"[p1_pool] P1_POOL_EN_RELW parse failed(非数字), 沿用定档默认0.3: {_EN_RELW_RAW}", file=sys.stderr)
_EN_REL_OVERRIDE_KEYS = {"Synonym": True, "IsA": True}  # 只覆盖被<0.1阈值拦截的两个关系

# ── 模式×机制 二值激活矩阵 [对照 p1_pool.mjs:MODE_ACTIVE/_isMechActive] ──
# 凛倾: "模式差异化不是调权重, 是激活不同的机制组合。不参与的机制完全沉默"
MODE_ACTIVE: dict[str, dict[str, bool]] = {
    "chat": {"names": True, "swow": True, "nb300": True, "cn": False, "sm": True, "cfn": True},
    "code": {"names": True, "swow": True, "nb300": True, "cn": True, "sm": False, "cfn": False},
    "work": {"names": True, "swow": True, "nb300": True, "cn": True, "sm": False, "cfn": True},
    "airp": {"names": True, "swow": True, "nb300": True, "cn": False, "sm": False, "cfn": True},
}


def _is_mech_active(mode: str, mech: str) -> bool:
    m = MODE_ACTIVE.get(mode) or MODE_ACTIVE["chat"]
    return m.get(mech) is not False  # 未知 mech 默认 active(Guard Clause: 新route接入前不被意外沉默)


def route_mode_res(ctx: dict[str, Any]) -> dict[str, Any]:
    requested_mode = ctx.get("mode")
    mode = "code" if requested_mode == "ide" else requested_mode
    if not mode:
        return {"words": [], "trace": {"route": "modeRes", "status": "noMode", "count": 0}}
    own = set(ctx.get("inputWords") or [])
    swow = ctx.get("swowPool")
    words: list[dict[str, Any]] = []
    words_set: set[str] = set()  # words.some(x=>x.word===t) 的 O(1) 镜像（成员语义相同）
    matched: list[str] = []
    subroutes: dict[str, Any] = {}

    def _in_pool(t: str) -> bool:
        return t in own or (swow is not None and t in swow) or t in words_set

    def _push(t: str, source: str, strength: float) -> None:
        words.append({"word": t, "source": source, "strength": strength})
        words_set.add(t)

    if _is_mech_active(mode, "cn") and mode in ("code", "work"):
        # ── CN: conceptnet 倒排发散(ide/code/work 激活, chat/airp 沉默) ──
        cn = _get_cn()
        if cn is None:
            subroutes["cn"] = {"status": "dataMissing", "error": _cn_err, "count": 0}
        else:
            before = len(words)
            k = int(res.env_num_or("P1_N2C_CN_TOPK", 10))  # [待实验定]
            for w in ctx.get("inputWords") or []:
                entry = cn.get(w)  # [对照 JS `cn[w] || cn[w.toLowerCase()]`] 空 dict 在 JS 是 truthy, 只有缺键才 fallback
                if entry is None:
                    entry = cn.get(w.lower())
                if not entry:
                    continue
                added = 0
                for rel, targets in entry.items():
                    base_w = REL_WEIGHTS.get(rel)
                    # [0731 定档] 该 rel 是否有资格被英文候选覆盖(仅 Synonym/IsA); 覆盖只在 per-target 层生效
                    can_en_override = _EN_RELW is not None and _EN_REL_OVERRIDE_KEYS.get(rel) is True
                    if not can_en_override and (base_w is None or base_w < 0.1):
                        continue  # <0.1 自动过滤(Synonym/IsA/Antonym)
                    for t in targets:
                        if not isinstance(t, str) or len(t) < 2:
                            continue
                        if _in_pool(t):
                            continue
                        rel_w = base_w
                        if can_en_override and (_EN_WORD_RE.match(w) or _EN_WORD_RE.match(t)):
                            rel_w = _EN_RELW  # 源词或目标词纯英文→英文专属权重; 中文候选仍走 baseW
                        if rel_w is None or rel_w < 0.1:
                            continue
                        _push(t, "mode:cn", round(rel_w, 3))  # strength=relWeight 直用
                        added += 1
                        if added >= k:
                            break
                    if added >= k:
                        break
                if added > 0:
                    matched.append(w + "→" + str(added))
            subroutes["cn"] = {"status": "active" if len(words) > before else "noHit",
                               "count": len(words) - before}

    if _is_mech_active(mode, "sm") and mode == "chat":
        # ── chat: sensorimotor 同感官通道发散("脖子"visual→"手指/眼睛") ──
        sm = _get_sm()
        if sm is None:
            subroutes["sm"] = {"status": "dataMissing", "error": _sm_err, "count": 0}
        else:
            before = len(words)
            k = int(res.env_num_or("P1_N2C_SM_TOPK", 8))  # [待实验定] 664词集小, topK宜小
            for w in ctx.get("inputWords") or []:
                entry = sm.get(w)
                if not entry:
                    continue
                mod = entry.get("dominant_modality")
                if not mod or _sm_by_modality is None:
                    continue
                bucket = _sm_by_modality.get(mod) or []
                added = 0
                for c in bucket:
                    if c["word"] == w or _in_pool(c["word"]):
                        continue
                    _push(c["word"], "mode:sm", 1.0)  # 激活时全权重(凛倾"不调权重=激活组合")
                    added += 1
                    if added >= k:
                        break
                if added > 0:
                    matched.append(w + "(" + mod + ")→" + str(added))
            subroutes["sm"] = {"status": "active" if len(words) > before else "noHit",
                               "count": len(words) - before}

    # ── CFN-Lex 中文语义框架发散(62280词757框架; SM 和 CFN 可并行激活) ──
    if _is_mech_active(mode, "cfn"):
        cfn = _get_cfn_data()
        if cfn is not None:
            before = len(words)
            k = int(res.env_num_or("P1_N2C_CFN_TOPK", 8))  # [待实验定]
            for w in ctx.get("inputWords") or []:
                frames = cfn["reverse"].get(w)
                if not frames:
                    continue
                added = 0
                for frame in frames:
                    siblings = cfn["forward"].get(frame)
                    if not siblings:
                        continue
                    for s in siblings:
                        if s == w or len(s) < 2:
                            continue
                        if _in_pool(s):
                            continue
                        _push(s, "mode:cfn", 1.0)
                        added += 1
                        if added >= k:
                            break
                    if added >= k:
                        break
                if added > 0:
                    matched.append(w + "(cfn:" + "/".join(frames[:2]) + ")→" + str(added))
            subroutes["cfn"] = {"status": "active" if len(words) > before else "noHit",
                                "count": len(words) - before}
        else:
            subroutes["cfn"] = {"status": "dataMissing", "error": _cfn_err, "count": 0}

    # ── 用户插拔词库子路由(全模式默认激活; _isMechActive 未知 mech 放行=预留通道语义) ──
    if _is_mech_active(mode, "user"):
        vocabs = [v for v in _get_user_vocab() if "all" in v["modes"] or mode in v["modes"]]
        if vocabs:
            before = len(words)
            k = int(res.env_num_or("P1_N2C_USER_TOPK", 10))  # [待实验定] 每词最多扩展数, 与CN同档
            for w in ctx.get("inputWords") or []:
                added = 0
                for v in vocabs:
                    targets = v["dict"].get(w)
                    if not isinstance(targets, list):
                        continue
                    for t in targets:
                        if not isinstance(t, str) or len(t) < 2 or t == w:
                            continue
                        if _in_pool(t):
                            continue
                        _push(t, "mode:user", 1.0)  # 激活组合不调权重口径
                        added += 1
                        if added >= k:
                            break
                    if added >= k:
                        break
                if added > 0:
                    matched.append(w + "(user)→" + str(added))
            subroutes["user"] = {"status": "active" if len(words) > before else "noHit",
                                 "count": len(words) - before, "files": len(vocabs)}

    return {
        "words": words,
        "trace": {
            "route": "modeRes", "status": "active" if words else "noHit",
            "requestedMode": requested_mode,
            "normalizedMode": mode,
            "subroutes": subroutes,
            "count": len(words), "matched": matched[:10],
        },
    }


# ── 池合并（CombSUM 加性: word → {sources[], strength累计}; 非swow新词 merge 进 swowPool）──
def build_recall_pool(ctx: dict[str, Any]) -> dict[str, Any]:
    """[对照 p1_pool.mjs:buildRecallPool 全函数逐段平移] 四路发散→合并→共振计票→单点扩池。"""
    routes = [route_names(ctx), route_swow(ctx), route_nb300(ctx), route_mode_res(ctx)]
    pool_map: dict[str, dict[str, Any]] = {}  # 插入序保留 = JS Map
    for r in routes:
        for c in r["words"]:
            e = pool_map.get(c["word"])
            if e is not None:
                e["sources"].append(c["source"])
                e["strength"] += c["strength"]  # CombSUM 加性累计
            else:
                pool_map[c["word"]] = {"word": c["word"], "sources": [c["source"]], "strength": c["strength"]}
    # ★S7-3 跨路径共振计票: strength += RES_W × (独立来源数-1)。去重铁则: new Set 去重后计独立路径数
    config_resonance = (ctx.get("recallConfig") or {}).get("resonanceW")
    res_w = (config_resonance if res.is_finite_number(config_resonance)
             else res.env_num_or("P1_POOL_RESONANCE_W", 0))
    resonance_hits = 0
    if res_w > 0:
        for e in pool_map.values():
            src_kinds = len(set(e["sources"]))
            if src_kinds > 1:
                e["strength"] += res_w * (src_kinds - 1)
                resonance_hits += 1
    # 单点扩池: 新 route 产出的词进 swowPool（swow 词本来就在池中, 只加新词）
    merged = 0
    swow_pool = ctx.get("swowPool")
    if swow_pool is not None and hasattr(swow_pool, "add"):
        for e in pool_map.values():
            if "swow" not in e["sources"] and e["word"] not in swow_pool:
                swow_pool.add(e["word"])
                merged += 1
    trace = {
        "routes": [r["trace"] for r in routes],
        "poolSize": len(pool_map),
        # 旧 multiSource 含单路重复 push 偏差, 保留向后兼容; multiSourceDedup=真·多路词数
        "multiSource": sum(1 for e in pool_map.values() if len(e["sources"]) > 1),
        "multiSourceDedup": sum(1 for e in pool_map.values() if len(set(e["sources"])) > 1),
        "resonance": {"w": res_w, "hits": resonance_hits},
        "merged": merged,  # 白盒: 本轮由非 swow 路新增进 swowPool 的词数
    }
    return {"swowPool": swow_pool, "poolMap": pool_map, "trace": trace}


def get_recall_pool_cache_stats() -> dict[str, Any]:
    """[对照 p1_pool.mjs:getRecallPoolCacheStats 口径逐键]"""
    return {
        "names": len(_names_idx) if _names_idx else 0,
        "conceptnetLoaded": _cn_data is not None,
        "sensorimotorLoaded": _sm_data is not None,
        "sensorimotorBuckets": len(_sm_by_modality) if _sm_by_modality else 0,
        "cfnForward": len(_cfn_fwd) if _cfn_fwd else 0,
        "cfnReverse": len(_cfn_rev) if _cfn_rev else 0,
        "userVocabFiles": len(_user_vocab_cache) if _user_vocab_cache else 0,
    }


def clear_recall_pool_caches() -> dict[str, Any]:
    """[对照 p1_pool.mjs:clearRecallPoolCaches] 清空全部路由缓存, 返回清空前统计。"""
    global _names_idx, _names_err, _cn_data, _cn_err, _sm_data, _sm_err, _sm_by_modality
    global _cfn_fwd, _cfn_rev, _cfn_err, _user_vocab_cache, _user_vocab_scan_at
    before = get_recall_pool_cache_stats()
    _names_idx = None
    _names_err = None
    _cn_data = None
    _cn_err = None
    _sm_data = None
    _sm_err = None
    _sm_by_modality = None
    _cfn_fwd = None
    _cfn_rev = None
    _cfn_err = None
    _user_vocab_cache = None
    _user_vocab_scan_at = 0.0
    return before


# ── JS 命名别名 ──
buildRecallPool = build_recall_pool
routeNames = route_names
routeSwow = route_swow
routeNb300 = route_nb300
routeModeRes = route_mode_res
getRecallPoolCacheStats = get_recall_pool_cache_stats
clearRecallPoolCaches = clear_recall_pool_caches
