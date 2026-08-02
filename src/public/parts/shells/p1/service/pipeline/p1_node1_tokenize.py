# ════════════════════════════════════════════════════════════════════
# p1_node1_tokenize.py — 节点1: 收拢 + 分词 + BCC排除（P1 三段机制第一段 = 收缩）
# [JS 平移真身: src/yonban/core/functions/memory/p1/p1_node1_tokenize.mjs, 2026-07-31 定档态]
#
# 功能链：p1_pipeline.py(主AI织合) → tokenize_node1(text, contextText, opts)
#         → {words, wordWeights, demoted, intensifiers, _trace}（字段名与 JS 版逐字一致，
#         前端 27 参数 meta 渲染/白盒消费方零改动）
# why：分词后用 BCC 高频表排无信息常用词（"的""了""是"），保留有诊断价值的实义词；
#      程度副词/极性强化词不删，另存 intensifiers 供下游加权。
# 关联链：
#   → resources_node1.py（BCC/双POS词典/THUOCL仲裁/否定词/英文表 装载，对照 JS 各 loader）
#   → jieba（Python 原版分词，替代 jieba-wasm；词典差异属预期，双跑对照容忍度报告定性）
# 平移保真：参数值全取 0730/0731 定档值（PARAMS 逐项 [对照 p1_node1_tokenize.mjs] 标注），
#   算法逐函数对照平移，发现 JS 疑似 quirk 只兼容不改行为（见函数内 [bug兼容] 标注）。
# 已知偏差（如实记录，非 hack 对齐）：
#   1. 长度计数 JS=UTF-16 code unit，Python=码点：BMP 内（几乎全部中文/英文）二者相等，
#      仅 emoji/增补平面字符差 1/字符——softLimitRecallText 截断点在含 emoji 长文上可能偏移。
#   2. jieba(Python) 与 jieba-wasm 词典/HMM 实现有差异 → words 集有 diff（设计 MD 规则 2 预期内）。
# ════════════════════════════════════════════════════════════════════
from __future__ import annotations

import re
import sys
from typing import Any, Optional

try:
    from . import resources_node1 as res
except ImportError:  # 独立脚本运行（拉线测试）时退化为平级 import
    import resources_node1 as res

# ── 魔法数字(0730/0731 实验定档) [对照 p1_node1_tokenize.mjs:PARAMS 逐项照值] ──
PARAMS: dict[str, float] = {
    # §5 P5 软降级三档: 硬排只排最顶档+POS虚词(极保守), 中频段软降权交下游空间投票
    "BCC_DEMOTE_FREQ": 500000,     # [0730定档] 118词探测: 情感/技术/工作词全<500K, 此值不误杀有信息词
    "BCC_HARDDROP_FREQ": 3000000,  # [0730定档] >3M只有"的了是在我你和"7个纯噪声词
    "BCC_DEMOTE_WEIGHT": 0.1,      # [0730定档] wordWeights 下游零消费时 demote=keep 等价, 保留供完整管线
    "MIN_WORD_LEN": 2,             # [0730定档] rescued 机制保底≥2词覆盖充分
    "FALLBACK_MAX_GRAM": 4,        # [0730定档] 无 jieba 时贪心最大匹配粒度上限
    "INPUT_TRUNCATE": 80,          # 历史 P1 对话契约默认值；生产请求可通过 inputMaxChars 覆盖
    "TRUNCATE_HEAD_RATIO": 0.3,    # [0731定档 b] 头尾双段截断首段预算占比(>80字案例字面词进池率41.7%→52.8%, 零噪声实证)
    "CONTEXT_WORD_LIMIT": 0,       # 仅作旧调用兼容；新调用由请求级 contextWordLimit 控制
}

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？!?.，,；;\n])\s*")
_ASCII_WORD_CHAR_RE = re.compile(r"[A-Za-z0-9]")
_ASCII_TAIL_RE = re.compile(r"[A-Za-z0-9]+$")
_ASCII_HEAD_RE = re.compile(r"^[A-Za-z0-9]+")


def soft_limit_recall_text(text: Any, max_chars: Any = None, short_segment_chars: Any = None) -> dict[str, Any]:
    """P1 召回输入软上限预处理（2026-07-31 起为头尾双段: 首段锚点 + 尾部近因）。
    [对照 p1_node1_tokenize.mjs:softLimitRecallText 全函数逐行平移]
    计数偏差：JS 用 UTF-16 code unit，此处用码点（BMP 内相等，见文件头偏差记录 1）。"""
    original = str(text) if text else ""
    n = res.to_finite_number(max_chars)
    limit = max(1, int(n)) if n is not None else int(PARAMS["INPUT_TRUNCATE"])
    n2 = res.to_finite_number(short_segment_chars)
    short_limit = max(1, int(n2)) if n2 is not None else 10
    if len(original) <= limit:
        return {
            "text": original,
            "originalLength": len(original),
            "processedLength": len(original),
            "truncated": False,
            "strategy": "unchanged",
        }

    raw_sentences = [s for s in _SENTENCE_SPLIT_RE.split(original) if s.strip()]
    merged_sentences: list[str] = []
    accumulated = ""
    for sentence in raw_sentences:
        trimmed = sentence.strip()
        if len(trimmed) < short_limit:
            accumulated = (accumulated + trimmed) if accumulated else trimmed
        else:
            if accumulated:
                merged_sentences.append(accumulated)
                accumulated = ""
            merged_sentences.append(trimmed)
    if accumulated:
        merged_sentences.append(accumulated)

    # [0731 定档] 头尾双段: 头=从开头按(短句合并后)整句累积到 headBudget; 尾=从尾部拼整句, 预算为剩余
    head_budget = max(1, int(limit * PARAMS["TRUNCATE_HEAD_RATIO"]))  # Math.floor: limit>0 ratio>0 → 截尾等价
    head = ""
    for sentence in merged_sentences:
        if len(head + sentence) > head_budget:
            break
        head += sentence
    if not head:
        head = original[:head_budget]  # 首句超长 → 硬切预算长度
        # 硬切词边界对齐: 切点两侧都是 ASCII 词字符 → 剪掉尾部半截(EXPECTED→ECTED 类倒排零命中噪声)
        nxt = original[head_budget] if head_budget < len(original) else ""
        if _ASCII_WORD_CHAR_RE.match(nxt) and _ASCII_TAIL_RE.search(head):
            head = _ASCII_TAIL_RE.sub("", head)
    tail_budget = limit - len(head) - 1  # -1 = 头尾分隔空格
    bounded_sentences = [s for s in merged_sentences if len(s) <= tail_budget] if tail_budget > 0 else []
    merged = ""
    for index in range(len(bounded_sentences) - 1, -1, -1):
        candidate = bounded_sentences[index] + ((" " + merged) if merged else "")
        if len(candidate) > tail_budget:
            break
        merged = candidate

    if merged:
        tail = merged
    elif tail_budget > 0:
        tail = original[-tail_budget:]  # 无整句可拼 → 尾部硬切(slice(-0)=全文陷阱, 须 tailBudget>0)
        # 同上词边界对齐: 尾段硬切的开头半截 ASCII token 剪掉
        prev_idx = len(original) - tail_budget - 1
        prev = original[prev_idx] if 0 <= prev_idx < len(original) else ""
        if _ASCII_WORD_CHAR_RE.match(prev) and _ASCII_HEAD_RE.match(tail):
            tail = _ASCII_HEAD_RE.sub("", tail)
    else:
        tail = ""
    # 去重叠保险: 头已完整含于尾(极短文本/极小 limit) → 只用尾
    processed = tail if (tail and head in tail) else ((head + " " + tail) if tail else head)
    return {
        "text": processed,
        "originalLength": len(original),
        "processedLength": len(processed),
        "truncated": processed != original,
        "strategy": "head-tail",
    }


# ── 虚词词性集合 [对照 node1:NOISE_POS/STRICT_NOISE_POS 同集] ──
NOISE_POS = {"d", "c", "f", "m", "q", "r", "p", "u", "e", "y", "o", "w", "s", "l"}
STRICT_NOISE_POS = {"u", "p", "c", "y", "e", "o", "r", "d"}


def _pos_in_noise(pos: Optional[str], pos_set: set[str]) -> bool:
    """[对照 node1:_posInNoise] 复合 POS 标签(ryv/rzv/vi/mq…)取首字母小写归一到大类再查表（0613 根因修）。"""
    return bool(pos) and pos[0].lower() in pos_set


# ── 程度副词/极性强化词(closed class) [对照 node1:DEGREE_WORDS 逐词照抄] ──
DEGREE_WORDS: set[str] = {
    "死了", "太", "好", "很", "非常", "超", "特别", "真", "实在", "真的", "简直", "完全", "彻底", "这么", "那么",
    "挺", "蛮", "颇", "相当", "极", "极其", "分外", "格外", "更", "更加", "越发", "尤其",
    "so", "really", "extremely", "absolutely", "totally", "completely",
}


def _en_lower(w: str) -> str:
    return w.lower()


def _is_en_stop(w: str) -> bool:
    return _en_lower(w) in res.get_en_lex()["stop"]


def _is_en_inten(w: str) -> bool:
    return _en_lower(w) in res.get_en_lex()["inten"]


def _is_en_neg(w: str) -> bool:
    return _en_lower(w) in res.get_en_lex()["neg"]


def _is_en_function_word(w: str) -> bool:
    """[对照 node1:_isEnFunctionWord] 停用词 ∪ intensifier ∪ negation = 英文全闭类。"""
    x = _en_lower(w)
    lex = res.get_en_lex()
    return x in lex["stop"] or x in lex["inten"] or x in lex["neg"]


def _is_function_word(w: str) -> bool:
    """[对照 node1:_isFunctionWord] 双词典都有数据→NOISE_POS 交集; 只一个→STRICT(高置信封闭类)。"""
    h_pos = res.get_hanlp_pos(w)
    j_pos = res.get_word_pos(w)
    if h_pos and j_pos:
        return _pos_in_noise(h_pos, NOISE_POS) and _pos_in_noise(j_pos, NOISE_POS)
    if h_pos:
        return _pos_in_noise(h_pos, STRICT_NOISE_POS)
    if j_pos:
        return _pos_in_noise(j_pos, STRICT_NOISE_POS)
    return False


_NVA_RE = re.compile(r"^[nva]")


def _is_content_pos(w: str) -> bool:
    """[对照 node1:_isContentPOS] 任一词典标 n/v/a → 有诊断价值实义词, 享 BCC 顶档保护。"""
    h = res.get_hanlp_pos(w)
    j = res.get_word_pos(w)
    return bool((h and _NVA_RE.match(h)) or (j and _NVA_RE.match(j)))


# ── jieba 单一入口 [对照 node1 jieba-wasm import + 响亮失败] ──
_jieba = None
try:
    import jieba as _jieba_mod
    _jieba = _jieba_mod
except ImportError:
    _jieba = None
    # 响亮失败（与 JS 同语义 0720）: 缺包必须出声, fallback 贪心已知产碎裂 token(我觉/我一)
    print("[p1_node1] jieba(Python) NOT AVAILABLE — falling back to BCC greedy segmentation "
          "(known to produce fractured tokens like 我觉/我一); pip 环境需自带 jieba。", file=sys.stderr)


def jieba_available() -> bool:
    return _jieba is not None


# [0731 Fix C 定档] 字母开头允许含数字: live2d/GPT4/html5/cmo3 类混排词不再落 non-cjk 硬删
_IS_EN_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9\-_]*$")
_IS_ZH_RE = re.compile(r"^[一-鿿]")
_IS_PUNCT_RE = re.compile(r"^[，。！？,.!?；;：:、…—\-~·\s]+$")


def _is_en(w: str) -> bool:
    return bool(_IS_EN_RE.match(w))


def _is_zh(w: str) -> bool:
    return bool(_IS_ZH_RE.match(w))


def _is_punct(w: str) -> bool:
    return bool(_IS_PUNCT_RE.match(w))


_FALLBACK_SEG_RE = re.compile(r"([一-鿿]+)|([a-zA-Z][a-zA-Z0-9\-_]*)")


def _tokenize_ordered(text: str) -> list[str]:
    """[对照 node1:_tokenizeOrdered] 主 jieba HMM, fallback BCC 贪心最大匹配; 返回有序 token 流(保留重复)。
    jieba-wasm cut(text,true)=HMM on ↔ Python jieba.lcut(text, HMM=True)（词典差异属预期偏差 2）。"""
    if _jieba is not None:
        return _jieba.lcut(text, HMM=True)
    out: list[str] = []
    max_gram = int(PARAMS["FALLBACK_MAX_GRAM"])
    min_len = int(PARAMS["MIN_WORD_LEN"])
    for m in _FALLBACK_SEG_RE.finditer(text):
        if m.group(2):
            out.append(m.group(2))
            continue
        seg = m.group(1)
        pos = 0
        while pos < len(seg):
            best, best_len, best_freq = None, 1, 0
            for length in range(min(max_gram, len(seg) - pos), min_len - 1, -1):
                w = seg[pos: pos + length]
                f = res.get_bcc_freq(w)
                if f > 0 and (length > best_len or (length == best_len and f > best_freq)):
                    best, best_len, best_freq = w, length, f
            if best and best_freq > 0:
                out.append(best)
                pos += best_len
            else:
                out.append(seg[pos])  # 单字也吐出, 留词性白名单决定去留
                pos += 1
    return out


def _classify_content(w: str) -> dict[str, Any]:
    """[对照 node1:_classifyContent] 内容词去留三档: keep(满权)/demote(软降权)/drop(硬排)。
    含 0731 单字中频 demote（镜像 2+字三档, 复用同组 PARAMS 零新魔法数字）。"""
    if _is_en(w):  # 英文豁免中文BCC, 但走英文停用词表
        if _is_en_stop(w):
            return {"tier": "drop", "weight": 0, "reason": "en-stopword"}
        return {"tier": "keep", "weight": 1.0, "reason": "en-content"}
    if not _is_zh(w):
        return {"tier": "drop", "weight": 0, "reason": "non-cjk"}
    freq = res.get_bcc_freq(w)
    if len(w) >= PARAMS["MIN_WORD_LEN"]:
        if _is_function_word(w):
            return {"tier": "drop", "weight": 0, "reason": "pos-function"}       # 双签虚词硬排
        if freq > PARAMS["BCC_HARDDROP_FREQ"]:
            return {"tier": "drop", "weight": 0, "reason": "bcc-toptier"}        # 最顶档高频硬排(极保守)
        if freq > PARAMS["BCC_DEMOTE_FREQ"]:                                     # 中频段软降权保留
            return {"tier": "demote", "weight": PARAMS["BCC_DEMOTE_WEIGHT"], "reason": "bcc-mid-demote"}
        return {"tier": "keep", "weight": 1.0, "reason": "content"}
    # 单字: 保留 n/v/a 且 BCC 未过中频档的(救 猫/怕/累)
    if _is_content_pos(w) and freq <= PARAMS["BCC_DEMOTE_FREQ"]:
        return {"tier": "keep", "weight": 1.0, "reason": "single-nva"}
    # [0731 定档] 单字中频段硬删→软降权（实证受害"爱吃"案"吃"freq 608K 被杀致语义丢半; 1600 端到端零退步）
    #   >HARDDROP 顶档(是/了/的)仍落下一行硬删, "去光杆动词"原意图对真高频保留
    if _is_content_pos(w) and freq <= PARAMS["BCC_HARDDROP_FREQ"]:
        return {"tier": "demote", "weight": PARAMS["BCC_DEMOTE_WEIGHT"], "reason": "single-nva-mid-demote"}
    return {"tier": "drop", "weight": 0, "reason": "single-drop"}


_N_POS_RE = re.compile(r"^n")


def tokenize_node1(text: Any, context_text: str = "", opts: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """节点1 主函数。[对照 node1:tokenizeNode1 全函数逐段平移]
    返回结构与 JS 版字段名逐字一致: {words, wordWeights, demoted, text, processedText,
    intensifiers, _trace{beforeFilter, afterFilter, filtered, demoted, wordWeights,
    bccFreqs, contextWords, jiebaAvailable, truncated, preprocess}}。"""
    opts = opts or {}
    # [对照 JS empty 块] 注意: JS empty 返回不含 processedText 键, 兼容保持不补
    empty = {
        "words": [], "wordWeights": {}, "demoted": [], "text": text or "", "intensifiers": [],
        "_trace": {"beforeFilter": [], "afterFilter": [], "filtered": [], "demoted": [],
                   "wordWeights": {}, "bccFreqs": {}, "contextWords": [],
                   "jiebaAvailable": jieba_available(), "truncated": False, "preprocess": None},
    }
    if (not text or not str(text).strip()) and (not context_text or not str(context_text).strip()):
        return empty

    preprocess = soft_limit_recall_text(
        text, max_chars=opts.get("inputMaxChars"), short_segment_chars=opts.get("shortSegmentChars"))
    truncated = preprocess["truncated"]
    main_text = preprocess["text"]

    tokens = _tokenize_ordered(main_text)

    # ① 走序列: 识别 intensifiers(不排), 分类内容词
    before_filter: list[str] = []   # 分词后、排噪前的全部候选词(去标点)
    after_filter: list[str] = []    # 排噪后保留进发散的词(keep+demote, 有序, 后去重)
    filtered: list[str] = []        # 被硬排掉的词(差集)
    demoted: list[str] = []         # 软降权保留的词(中频段)
    word_weights: dict[str, float] = {}
    bcc_freqs: dict[str, int] = {}
    intensifiers: list[dict[str, Any]] = []
    _int_pos: list[int] = []        # 与 intensifiers 平行的 token 位置(JS 用临时 _pos 字段)
    keep_flags: list[bool] = []     # 与 tokens 同长: True=进发散的信息词, 供 intensifier 找前置 target

    negation_words = res.get_negation_words()
    for i, w in enumerate(tokens):
        keep_flags.append(False)
        if not w or _is_punct(w):
            continue
        if _is_zh(w):
            bcc_freqs[w] = res.get_bcc_freq(w)

        # intensifier: 程度副词/否定词 → 另存信号, 不进 words, 也不算"被排掉"
        if w in DEGREE_WORDS or (_is_en(w) and _is_en_inten(w)):
            intensifiers.append({"word": w, "target": None, "type": "degree"})
            _int_pos.append(i)
            continue
        if w in negation_words or (_is_en(w) and _is_en_neg(w)):
            intensifiers.append({"word": w, "target": None, "type": "negation"})
            _int_pos.append(i)
            continue

        before_filter.append(w)
        c = _classify_content(w)
        if c["tier"] == "drop":
            filtered.append(w)
            continue
        after_filter.append(w)
        keep_flags[i] = True
        word_weights[w] = c["weight"]
        if c["tier"] == "demote":
            demoted.append(w)

    # ② intensifier 找 target: 仅向后挂"它后面最近的进发散信息词"; 跨标点不算前置修饰
    for it, p in zip(intensifiers, _int_pos):
        tgt = None
        for j in range(p + 1, len(tokens)):
            if _is_punct(tokens[j]):
                break
            if keep_flags[j]:
                tgt = tokens[j]
                break
        it["target"] = tgt

    # ③ 上下文并入（0730 002指令"保留名词为主"; 分词后只取名词, 限 contextWordLimit 默认 15）
    ctx_words: list[str] = []
    configured_limit = res.to_finite_number(opts.get("contextWordLimit"))
    # [0730区分度修复] 旧值 Infinity→15: 67 名词淹没 input 专属词→3条不同输入召回相同top4
    context_word_limit = max(0, int(configured_limit)) if configured_limit is not None else 15
    if context_word_limit > 0 and context_text and str(context_text).strip():
        for w in _tokenize_ordered(str(context_text)):
            if len(ctx_words) >= context_word_limit:
                break
            if _is_punct(w) or w in DEGREE_WORDS or w in negation_words:
                continue
            c = _classify_content(w)
            if c["tier"] == "drop":
                continue
            # [0730 002指令] 上下文词只保留名词为主——双词典取 POS，任一标 n 开头即保留
            h_pos = res.get_hanlp_pos(w)
            j_pos = res.get_word_pos(w)
            is_noun = bool((h_pos and _N_POS_RE.match(h_pos)) or (j_pos and _N_POS_RE.match(j_pos)))
            if not is_noun:
                continue
            ctx_words.append(w)
            if w not in word_weights:  # 上下文词不覆盖主输入词权重（权重通道）
                word_weights[w] = c["weight"]

    # ④ 收拢落地: 去重取唯一词集(主输入词在前, 上下文词补后)
    seen: set[str] = set()
    words: list[str] = []
    for w in after_filter + ctx_words:
        if w not in seen:
            words.append(w)
            seen.add(w)

    # ⑤ 短句保底(P5): words 过少时从 filtered 回收最低频非极高频词, 权重 0.3
    #    [对照 node1 L493-509] env 每次调用读取（与 JS 函数内 const 一致）
    min_words_floor = int(res.env_num_or("P1_MIN_WORDS_FLOOR", 2))
    bcc_rescue_ceil = res.env_num_or("P1_BCC_RESCUE_CEIL", 2000000)
    rescued_weight = res.env_num_or("P1_RESCUED_WEIGHT", 0.3)
    rescued: list[str] = []
    if len(words) < min_words_floor and filtered:
        # [bug兼容] JS 候选 filter 用快照 seen, 循环内不再查 seen → filtered 含重复词时可重复回收, 兼容保持
        candidates = sorted(
            (w for w in filtered if w not in seen and len(w) >= 2 and (bcc_freqs.get(w) or 0) <= bcc_rescue_ceil),
            key=lambda w: bcc_freqs.get(w) or 0)  # BCC 升序(低频=高信息量); Python sorted 稳定=JS 稳定排序
        for w in candidates:
            if len(words) >= min_words_floor:
                break
            words.append(w)
            seen.add(w)
            word_weights[w] = rescued_weight
            rescued.append(w)

    return {
        "words": words,
        "wordWeights": word_weights,
        "demoted": demoted,
        "text": text,
        "processedText": main_text,
        "intensifiers": intensifiers,
        "_trace": {
            "beforeFilter": before_filter,
            "afterFilter": after_filter,
            "filtered": filtered,
            "demoted": demoted,
            "wordWeights": word_weights,
            "bccFreqs": bcc_freqs,
            "contextWords": ctx_words,
            "jiebaAvailable": jieba_available(),
            "truncated": truncated,
            "preprocess": preprocess,
        },
    }


# ════════════════════════════════════════════════════════════════════
# tokenizeRecall — 零回归口径（P1_NODE1_V2=off 回退时才走）[对照 node1:tokenizeRecall/_isNoiseRecall]
# ════════════════════════════════════════════════════════════════════
_RECALL_NOISE_POS = {"d", "c", "f", "m", "q", "r", "p", "u", "e", "y", "o", "w", "s", "l"}


def _is_noise_recall(w: str) -> bool:
    """[对照 node1:_isNoiseRecall] 英文走闭类表; 中文 HanLP∩jieba 双签 + THUOCL 专业域前缀仲裁放行。"""
    if _is_en(w):
        return _is_en_function_word(w)
    h_pos = res.get_hanlp_pos(w)
    j_pos = res.get_word_pos(w)
    h_noise = _pos_in_noise(h_pos, _RECALL_NOISE_POS)
    j_noise = _pos_in_noise(j_pos, _RECALL_NOISE_POS)
    if h_pos and j_pos:
        return h_noise and j_noise and not res.thuocl_domain_content(w)
    if h_pos:
        return h_noise and not res.thuocl_domain_content(w)
    if j_pos:
        return j_noise and not res.thuocl_domain_content(w)
    return False


_RECALL_TRUNCATE = 100  # [待实验定] 逐字搬自重构前 recallV2 截断值
_RECALL_PUNCT_RE = re.compile(r"^[，。！？,.!?；;：:\s]+$")
_ZH_SEG_RE = re.compile(r"[一-鿿]+")
_EN_SEG_RE = re.compile(r"[a-zA-Z]{2,}")


def _run_step1_extract_words(text: str) -> list[str]:
    """[对照 selfDrivenP1_utils.mjs:runStep1Extract 无 jieba 分支逐行平移]
    贪心最大匹配(4..2)+seen 预去重, 中文段后统一追加英文段(≥2字母), 不吐单字。
    （有 jieba 分支不在此实现: tokenizeRecall 只在 jieba 缺席时才走本函数, 与 JS 调用面一致。）"""
    if not text:
        return []
    seen: set[str] = set()
    words: list[str] = []
    for seg in _ZH_SEG_RE.findall(text):
        pos = 0
        while pos < len(seg):
            best, best_len, best_freq = None, 1, 0
            for length in range(min(4, len(seg) - pos), 1, -1):
                w = seg[pos: pos + length]
                f = res.get_bcc_freq(w)
                if f > 0 and (length > best_len or (length == best_len and f > best_freq)):
                    best, best_len, best_freq = w, length, f
            if best and best_freq > 0:
                if best not in seen:
                    words.append(best)
                    seen.add(best)
                pos += best_len
            else:
                pos += 1
    for w in _EN_SEG_RE.findall(text):
        if w not in seen:
            words.append(w)
            seen.add(w)
    return words


def tokenize_recall(input_text: Any) -> dict[str, Any]:
    """节点1 召回侧分词(零回归口径)。[对照 node1:tokenizeRecall]
    返回 {inputWords, _isNoise}（_isNoise 供节点2 复用同一虚词判定）。"""
    text = input_text or ""
    _text = text[:_RECALL_TRUNCATE] if len(text) > _RECALL_TRUNCATE else text
    if _jieba is not None:
        raw_tokens = _jieba.lcut(_text, HMM=True)
    else:
        raw_tokens = _run_step1_extract_words(_text)
    input_words: list[str] = []
    for w in raw_tokens:
        if not w or not w.strip():
            continue
        if _RECALL_PUNCT_RE.match(w):
            continue
        if _is_noise_recall(w):
            continue
        if len(w) >= 2:
            if res.get_bcc_freq(w) < 500000:  # [待实验定] 500K
                input_words.append(w)
            continue
        h = res.get_hanlp_pos(w)
        if h and _NVA_RE.match(h):
            input_words.append(w)
    return {"inputWords": input_words, "_isNoise": _is_noise_recall}


def get_node1_tokenize_cache_stats() -> dict[str, Any]:
    """[对照 node1:getNode1TokenizeCacheStats] 资源缓存计数 + 分词器就绪。"""
    stats = res.get_node1_resource_cache_stats()
    stats["tokenizerLoaded"] = jieba_available()
    return stats


def clear_node1_tokenize_caches() -> None:
    """[对照 node1:clearNode1TokenizeCaches]"""
    res.clear_node1_resource_caches()


# ── JS 命名别名（管线织合/双跑脚本可用同名调用, 降低对照成本） ──
softLimitRecallText = soft_limit_recall_text
tokenizeNode1 = tokenize_node1
tokenizeRecall = tokenize_recall
jiebaAvailable = jieba_available
clearNode1TokenizeCaches = clear_node1_tokenize_caches
getNode1TokenizeCacheStats = get_node1_tokenize_cache_stats


# ── 单点断点 / 单节点独立测试 [对照 node1 尾部 _isMain 块]: python p1_node1_tokenize.py "句子" ──
if __name__ == "__main__":
    import json as _json
    _input = sys.argv[1] if len(sys.argv) > 1 else "我最近加班太多了,感觉整个人都很疲惫"
    _r = tokenize_node1(_input)
    print("[node1-断点] input   =", _input)
    print("[node1-断点] jieba   =", _r["_trace"]["jiebaAvailable"], "truncated =", _r["_trace"]["truncated"])
    print("[node1-断点] words   =", _json.dumps(_r["words"], ensure_ascii=False))
    print("[node1-断点] weights =", _json.dumps(_r["wordWeights"], ensure_ascii=False))
    print("[node1-断点] demoted =", _json.dumps(_r["demoted"], ensure_ascii=False))
    print("[node1-断点] intens  =", _json.dumps(_r["intensifiers"], ensure_ascii=False))
    print("[node1-before]", _json.dumps(_r["_trace"]["beforeFilter"], ensure_ascii=False))
    print("[node1-after ]", _json.dumps(_r["_trace"]["afterFilter"], ensure_ascii=False))
    print("[node1-硬排  ]", _json.dumps(_r["_trace"]["filtered"], ensure_ascii=False))
    print("[node1-BCC   ]", _json.dumps(_r["_trace"]["bccFreqs"], ensure_ascii=False))
