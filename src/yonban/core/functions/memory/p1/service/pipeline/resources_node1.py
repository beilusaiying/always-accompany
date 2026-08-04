# ════════════════════════════════════════════════════════════════════
# resources_node1.py — P1 Python 管线：分词层三节点(node1/node2/pool)共用资源装载
#
# 功能链：p1_node1_tokenize.py / p1_node2_swow.py / p1_pool.py → 本文件各 get_* loader
#         → 现 JS memory 目录下的资源 JSON/CSV/TXT（零拷贝直接复用，路径可配置）
# why：JS 侧资源装载散在 selfDrivenP1_utils.mjs / wordCoords.mjs / wordClassify.mjs /
#      p1_resdir.mjs / 各节点文件内；Python 平移把"这三个节点用到的部分"收口到本文件，
#      装载语义逐函数对照 JS 源（解析格式/候选序/失败退化行为全部保真）。
# 关联链（对照 JS 源）：
#   → p1_resdir.mjs getResDir/findResource（单次启动只认 P1_RESOURCE_DIR 指向的唯一资源根）
#   → selfDrivenP1_utils.mjs _getBccDict/_getBccFreq（multi_domain_total_word_freq.txt 436K 词）
#   → wordCoords.mjs _loadPOS/getWordPOS（jieba_dict.txt）、_loadSwow/swowDiverge（SWOW zh/en + synonym fallback3 + distance 门控）
#   → wordClassify.mjs isStopword（chinese-stopwords 三表 union）
#   → p1_node1_tokenize.mjs _getHanlpPOS（CoreNatureDictionary.txt）/_loadThuoclPrefixIdx/
#     _getNegationWords（polarity_lexicon.json）/_getEnLex（english_stopwords.json）
#   → p1_node2_swow.mjs _loadSwowZhCues（swow_zh24_official.json 独立 loader）
# 影响范围：只读资源文件，模块级懒加载缓存；clear_* 系列清缓存供热更新/测试。
# 路径配置：MEMORY_DIR 默认指向现 JS memory 目录（相对推导优先，env P1_PY_MEMORY_DIR 覆盖）。
# NB300：本文件只留 provider 挂钩（set_numberbatch_provider），bin 解析归分身B/resources.py。
# ════════════════════════════════════════════════════════════════════
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from p1_paths import RESOURCE_ROOT, STORAGE_ROOT

MEMORY_DIR: Path = RESOURCE_ROOT
_res_dir: Optional[Path] = None


def get_res_dir() -> Path:
    """返回本次启动选定的唯一资源根；根缺失时响亮失败。"""
    global _res_dir
    if _res_dir is not None:
        return _res_dir
    if not RESOURCE_ROOT.exists():
        raise RuntimeError(f"P1_RESOURCE_ROOT_MISSING: {RESOURCE_ROOT}")
    _res_dir = RESOURCE_ROOT
    return _res_dir


def find_resource(rel: str) -> Optional[Path]:
    """只在唯一资源根内找文件；单项可选性由消费 loader 决定。"""
    p = get_res_dir() / rel
    return p if p.exists() else None


def resolve_resource(filename: str) -> Optional[Path]:
    """[对照 selfDrivenP1_utils.mjs:resolveResource] memory 根 > memory/resources > p1_res 候选链。"""
    for p in (MEMORY_DIR / filename,):
        if p.exists():
            return p
    return find_resource(filename)


# ── 用户插拔词库目录：正式请求显式传 vocabRoot；独立管线调用只回到 storage/p1，
#   不得读取 host data 或旧插件目录。每次调用现解析=config 热改即生效。──
def get_user_vocab_dir() -> Path:
    env = os.environ.get("P1_PY_USER_VOCAB_DIR")
    if env:
        return Path(env)
    try:
        from p1_config import get_config  # service/ 在 sys.path 时（p1_server 启动）可达
        return Path(get_config()["vocabDir"])
    except ImportError:
        return STORAGE_ROOT / "vocab"


# （0731）模块级常量已废：import 时固化会锁死 config 热改+读A写B——消费方改调 get_user_vocab_dir()


# ── env 数值助手（JS 两种取 env 数值的形状，分别镜像） ──
def env_num(name: str, default: float) -> float:
    """[对照 JS `Number(process.env.X ?? d)`] 未设→默认；空串→0（JS Number("")===0）；非数字→warn+默认。
    偏差记录：JS 非数字得 NaN 并向下游传播，Python 侧改为响亮 warn+默认（NaN 在 int 上下文不可用）。"""
    raw = os.environ.get(name)
    if raw is None:
        return default
    if raw == "":
        return 0.0
    try:
        return float(raw)
    except ValueError:
        print(f"[p1_res] env {name}={raw!r} 非数字, 用默认 {default}", file=sys.stderr)
        return default


def env_num_or(name: str, default: float) -> float:
    """[对照 JS `+(process.env.X || d)`] 未设/空串→默认；非数字→warn+默认（JS 为 NaN，偏差同上）。"""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        print(f"[p1_res] env {name}={raw!r} 非数字, 用默认 {default}", file=sys.stderr)
        return default


def is_finite_number(v: Any) -> bool:
    """[对照 JS Number.isFinite] bool 不算数字（JS true 不是 number 类型语义上算，但配置层传 bool 视为误用，排除）。"""
    import math
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def to_finite_number(v: Any) -> Optional[float]:
    """[对照 JS Number(v) + Number.isFinite 判定] None/undefined→None(NaN)；数字串可转；其余 None。"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        import math
        return float(v) if math.isfinite(v) else None
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0  # JS Number("")===0
        try:
            return float(s)
        except ValueError:
            return None
    return None


# ── OrderedSet：JS Set 是插入序的，下游（池合并/trace 采样/召回打分迭代）依赖此序，Python set 无序不可用 ──
class OrderedSet:
    """镜像 JS Set 最小接口（add/has/forEach 插入序迭代/size）。"""

    __slots__ = ("_d",)

    def __init__(self, iterable: Any = ()) -> None:
        self._d: dict[Any, None] = dict.fromkeys(iterable)

    def add(self, x: Any) -> None:
        self._d.setdefault(x, None)

    def __contains__(self, x: Any) -> bool:
        return x in self._d

    def __iter__(self) -> Iterator[Any]:
        return iter(self._d)

    def __len__(self) -> int:
        return len(self._d)

    def __repr__(self) -> str:
        return f"OrderedSet({list(self._d)!r})"


def _read_text(p: Path) -> str:
    # utf-8-sig = JS 侧 `.replace(/^\uFEFF/,"")` BOM strip 的等价物
    return p.read_text(encoding="utf-8-sig")


def _load_json(p: Path) -> Any:
    return json.loads(_read_text(p))


# ════════════════════════════════════════════════════════════════════
# BCC 频率表 [对照 selfDrivenP1_utils.mjs:_getBccDict/_getBccFreq]
# ════════════════════════════════════════════════════════════════════
_bcc_dict: Optional[dict[str, int]] = None
_PARSE_INT_RE = re.compile(r"\s*[+-]?\d+")  # JS parseInt 前缀数字语义


def get_bcc_dict() -> dict[str, int]:
    global _bcc_dict
    if _bcc_dict is not None:
        return _bcc_dict
    _bcc_dict = {}
    try:
        f = resolve_resource("multi_domain_total_word_freq.txt")
        if f is None:
            return _bcc_dict
        lines = f.read_text(encoding="utf-8").split("\n")
        for i, raw in enumerate(lines):
            line = raw.strip()
            # [对照 JS] `!line || i===0 && line.startsWith("token")`（优先级：|| 低于 &&）
            if not line or (i == 0 and line.startswith("token")):
                continue
            sep = "\t" if "\t" in line else ","
            idx = line.rfind(sep)
            if idx < 0:
                continue
            w = line[:idx].strip()
            m = _PARSE_INT_RE.match(line[idx + 1:])
            if w and m:
                _bcc_dict[w] = int(m.group())
    except OSError:
        _bcc_dict = {}
    return _bcc_dict


def get_bcc_freq(w: str) -> int:
    return get_bcc_dict().get(w, 0)


# ════════════════════════════════════════════════════════════════════
# 双 POS 词典 [对照 p1_node1_tokenize.mjs:_getHanlpPOS + wordCoords.mjs:_loadPOS/getWordPOS]
# ════════════════════════════════════════════════════════════════════
_hanlp_dict: Optional[dict[str, str]] = None


def get_hanlp_pos(w: str) -> Optional[str]:
    """[对照 p1_node1_tokenize.mjs:_getHanlpPOS] CoreNatureDictionary.txt(153K) \\t 分列 词→首 POS。"""
    global _hanlp_dict
    if _hanlp_dict is None:
        _hanlp_dict = {}
        f = get_res_dir() / "CoreNatureDictionary.txt"
        if f.exists():
            for line in f.read_text(encoding="utf-8").split("\n"):
                parts = line.split("\t")
                if len(parts) >= 2:
                    _hanlp_dict[parts[0]] = parts[1]
    return _hanlp_dict.get(w)


_jieba_pos_map: Optional[dict[str, str]] = None


def get_word_pos(w: str) -> Optional[str]:
    """[对照 wordCoords.mjs:getWordPOS/_loadPOS] jieba_dict.txt 空格分列 "词 频 POS" → 词→POS。"""
    global _jieba_pos_map
    if _jieba_pos_map is None:
        _jieba_pos_map = {}
        f = get_res_dir() / "jieba_dict.txt"
        if not f.exists():
            print("[p1_res] jieba_dict.txt not found", file=sys.stderr)
        else:
            for line in f.read_text(encoding="utf-8").split("\n"):
                parts = line.strip().split(" ")
                if len(parts) >= 3:
                    _jieba_pos_map[parts[0]] = parts[2]
    return _jieba_pos_map.get(w) or None


# ════════════════════════════════════════════════════════════════════
# THUOCL 专业域前缀索引 [对照 p1_node1_tokenize.mjs:_loadThuoclPrefixIdx/_thuoclDomainContent]
# ════════════════════════════════════════════════════════════════════
_THUOCL_EXCLUDE = {"THUOCL_poem.txt", "THUOCL_chengyu.txt", "THUOCL_diming.txt", "THUOCL_lishimingren.txt"}
_thuocl_prefix_idx: Optional[dict[str, dict[str, int]]] = None
_SPLIT_WS_RE = re.compile(r"\s+")


def _load_thuocl_prefix_idx() -> dict[str, dict[str, int]]:
    global _thuocl_prefix_idx
    if _thuocl_prefix_idx is not None:
        return _thuocl_prefix_idx
    _thuocl_prefix_idx = {}
    try:
        d = get_res_dir() / "THUOCL" / "data"
        for fn in os.listdir(d):
            if not fn.startswith("THUOCL_") or not fn.endswith(".txt") or fn in _THUOCL_EXCLUDE:
                continue
            dom = fn[7:-4]
            for line in (d / fn).read_text(encoding="utf-8").split("\n"):
                w = (_SPLIT_WS_RE.split(line)[0] or "").strip()
                if not w or len(w) < 3:  # 库词需长于前缀才构成"w 是更长术语的前缀"
                    continue
                for plen in (2, 3):
                    if len(w) <= plen:
                        continue
                    p = w[:plen]
                    m = _thuocl_prefix_idx.setdefault(p, {})
                    m[dom] = m.get(dom, 0) + 1
    except OSError as e:
        print(f"[p1_node1] THUOCL 前缀索引加载失败(仲裁退化为空, 不崩): {e}", file=sys.stderr)
    return _thuocl_prefix_idx


_THUOCL_PREFIX_K = int(env_num_or("P1_N1_THUOCL_PREFIX_K", 3))  # [对照 node1:_THUOCL_PREFIX_K 默认3]


def thuocl_domain_content(w: str) -> bool:
    """[对照 node1:_thuoclDomainContent] 词 w 在任一专业域有 ≥K 个以它开头的库词 → 内容词证据。"""
    if not w or len(w) < 2 or len(w) > 3:
        return False
    m = _load_thuocl_prefix_idx().get(w)
    if not m:
        return False
    return any(c >= _THUOCL_PREFIX_K for c in m.values())


# ════════════════════════════════════════════════════════════════════
# 否定词 [对照 p1_node1_tokenize.mjs:_getNegationWords] polarity_lexicon.json#negation_zh∪negation_en
# ════════════════════════════════════════════════════════════════════
_negation_words: Optional[set[str]] = None


def get_negation_words() -> set[str]:
    global _negation_words
    if _negation_words is not None:
        return _negation_words
    try:
        plex = _load_json(MEMORY_DIR / "polarity_lexicon.json")
        _negation_words = set(plex.get("negation_zh") or []) | set(plex.get("negation_en") or [])
    except (OSError, json.JSONDecodeError) as e:
        # [对照 node1] 加载失败=warn+空集（响亮暴露，不兜底第二份硬编码——兜底=双源回潮）
        print(f"[p1_node1] polarity_lexicon.json negation load failed: {e}", file=sys.stderr)
        _negation_words = set()
    return _negation_words


# ════════════════════════════════════════════════════════════════════
# 英文停用词/intensifier/negation [对照 p1_node1_tokenize.mjs:_getEnLex]
# ════════════════════════════════════════════════════════════════════
_en_lex: Optional[dict[str, set[str]]] = None


def get_en_lex() -> dict[str, set[str]]:
    global _en_lex
    if _en_lex is not None:
        return _en_lex
    _en_lex = {"stop": set(), "inten": set(), "neg": set()}
    if os.environ.get("P1_EN_STOP") == "off":  # 测试钩子: 关英文停用词作 A/B 基线（默认开）
        return _en_lex
    try:
        j = _load_json(MEMORY_DIR / "english_stopwords.json")
        _en_lex["stop"].update(j.get("stopwords") or [])
        _en_lex["inten"].update(j.get("intensifiers") or [])
        _en_lex["neg"].update(j.get("negations") or [])
    except (OSError, json.JSONDecodeError) as e:
        print(f"[p1_node1] english_stopwords load failed: {e}", file=sys.stderr)
    return _en_lex


# ════════════════════════════════════════════════════════════════════
# 中文停用词三表 union [对照 wordClassify.mjs:_loadStop/isStopword]
# ════════════════════════════════════════════════════════════════════
_stopwords: Optional[set[str]] = None


def is_stopword(w: str) -> bool:
    global _stopwords
    if _stopwords is None:
        _stopwords = set()
        for fn in ("baidu_stopwords.txt", "hit_stopwords.txt", "cn_stopwords.txt"):
            try:
                for line in (get_res_dir() / "chinese-stopwords" / fn).read_text(encoding="utf-8").split("\n"):
                    t = line.strip()
                    if t:
                        _stopwords.add(t)
            except OSError:
                continue  # 缺某表不致命, union 其余
    return w in _stopwords


# ════════════════════════════════════════════════════════════════════
# SWOW 联想网络 + swow_diverge [对照 wordCoords.mjs:_loadSwow/swowDiverge]
# ════════════════════════════════════════════════════════════════════
_swow_zh: Optional[dict[str, Any]] = None
_swow_en: Optional[dict[str, Any]] = None
_synonym_map: Optional[dict[str, Any]] = None


def _swow_array_to_dict(raw: Any) -> dict[str, Any]:
    # zh24_official 是数组[{cue,responses}] → 转字典 {cue:responses}
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and raw[0].get("cue"):
        d: dict[str, Any] = {}
        for entry in raw:
            if entry.get("cue") and entry.get("responses") is not None:
                d[entry["cue"]] = entry["responses"]
        return d
    return raw if isinstance(raw, dict) else {}


def _load_swow() -> None:
    global _swow_zh, _swow_en
    if _swow_zh is not None:
        return
    zh_real = MEMORY_DIR / "swow_zh24_official.json"
    zh_full = MEMORY_DIR / "swow_zh_full.json"
    zh_small = MEMORY_DIR / "swow_associations.json"
    en_full = MEMORY_DIR / "swow_en_full.json"
    en_small = MEMORY_DIR / "swow_associations_en.json"
    try:
        src = zh_real if zh_real.exists() else (zh_full if zh_full.exists() else zh_small)
        _swow_zh = _swow_array_to_dict(_load_json(src))
    except (OSError, json.JSONDecodeError):
        _swow_zh = {}
    try:
        _swow_en = _load_json(en_full if en_full.exists() else en_small)
        if not isinstance(_swow_en, dict):
            _swow_en = {}
    except (OSError, json.JSONDecodeError):
        _swow_en = {}


_SWOW_EN_WORD_RE = re.compile(r"^[a-zA-Z][a-zA-Z\s'\-]*$")  # [对照 swowDiverge] 纯ASCII字母(含空格/连字符/撇号)


def swow_diverge(anchor_word: str, top_k: int = 8, opts: Optional[dict[str, Any]] = None) -> list[dict[str, Any]]:
    """[对照 wordCoords.mjs:swowDiverge] SWOW 联想发散：en/zh 优先序 + synonym fallback3 +
    strength 降序 + distance 门控（opts={"distance":"on","cosToAnchor":fn} 时滤 cos≥MAXCOS 近义）。"""
    global _synonym_map
    _load_swow()
    assert _swow_zh is not None and _swow_en is not None
    is_en = bool(_SWOW_EN_WORD_RE.match(anchor_word or ""))
    if is_en:
        assocs = (_swow_en.get(anchor_word.lower()) or _swow_en.get(anchor_word)
                  or _swow_zh.get(anchor_word) or [])
    else:
        assocs = (_swow_zh.get(anchor_word)
                  or _swow_en.get(anchor_word.lower() if anchor_word else anchor_word) or [])

    # fallback 1+2 关闭（与 JS 同：子串/单字拆分产字面噪声）；fallback 3: 同义词查SWOW
    if not assocs:
        if _synonym_map is None:
            try:
                _synonym_map = _load_json(MEMORY_DIR / "synonym_index.json")
            except (OSError, json.JSONDecodeError):
                _synonym_map = {}
        syns = _synonym_map.get(anchor_word)
        if syns:
            for syn in syns:
                assocs = _swow_zh.get(syn) or []
                if assocs:
                    break
    if not assocs:
        return []

    # 2025版带strength权重: [{word,strength,rank}] → 按strength降序（Python sorted 稳定=JS 规范排序稳定）
    has_strength = bool(assocs) and isinstance(assocs[0], dict) and "strength" in assocs[0]
    sorted_assocs = (sorted(assocs, key=lambda a: -(a.get("strength") or 0)) if has_strength else assocs)

    candidates: list[dict[str, Any]] = []
    for idx, a in enumerate(sorted_assocs):
        if isinstance(a, dict):
            word = a.get("word") or str(a)
            rank = a.get("rank") or (idx + 1)  # [对照 JS] falsy rank → idx+1
            strength = a.get("strength")       # 无 strength → None（JS undefined，同为"非有限数"）
        else:
            word = str(a)
            rank = idx + 1
            strength = None                    # JS 此处为 false，语义同"非有限数"
        candidates.append({"word": word, "strength": strength, "rank": rank, "source": "swow"})

    # distance 门控消费端 [对照 swowDiverge 尾部, 0703 补断链]：先滤后 slice，保证 topK 从合格池取满
    if opts and str(opts.get("distance")) == "on" and callable(opts.get("cosToAnchor")):
        max_cos = env_num_or("P1_N2_SWOW_DISTANCE_MAXCOS", 0.85)
        cos_fn = opts["cosToAnchor"]
        filtered = [c for c in candidates
                    if not (isinstance(cos := cos_fn(c["word"]), (int, float)) and not isinstance(cos, bool) and cos >= max_cos)]
        return filtered[: int(top_k)]

    return candidates[: int(top_k)]


# ── SWOW zh cue 字典（node2 QKV 的 K 集合）[对照 p1_node2_swow.mjs:_loadSwowZhCues 独立 loader] ──
_swow_zh_cue_cache: Optional[dict[str, Any]] = None


def load_swow_zh_cues() -> dict[str, Any]:
    global _swow_zh_cue_cache
    if _swow_zh_cue_cache is not None:
        return _swow_zh_cue_cache
    zh_real = MEMORY_DIR / "swow_zh24_official.json"
    zh_full = MEMORY_DIR / "swow_zh_full.json"
    try:
        raw = _load_json(zh_real if zh_real.exists() else zh_full)
        _swow_zh_cue_cache = _swow_array_to_dict(raw)
    except (OSError, json.JSONDecodeError):
        _swow_zh_cue_cache = {}
    return _swow_zh_cue_cache


# ════════════════════════════════════════════════════════════════════
# 口语疑问/虚词补集 [对照 p1_node2_swow.mjs:_getColloquialNonInfo] p1_colloquial_noninfo.json
# ════════════════════════════════════════════════════════════════════
_colloquial_noninfo: Optional[set[str]] = None


def get_colloquial_noninfo() -> set[str]:
    global _colloquial_noninfo
    if _colloquial_noninfo is not None:
        return _colloquial_noninfo
    try:
        j = _load_json(MEMORY_DIR / "p1_colloquial_noninfo.json")
        _colloquial_noninfo = set(j.get("words") or [])
    except (OSError, json.JSONDecodeError) as e:
        print(f"[p1_node2] p1_colloquial_noninfo.json load failed: {e}", file=sys.stderr)
        _colloquial_noninfo = set()
    return _colloquial_noninfo


# ════════════════════════════════════════════════════════════════════
# NB300 provider 挂钩（bin 解析归分身B/resources.py；未接线时返回 None=JS getNumberbatch 缺席语义）
# ════════════════════════════════════════════════════════════════════
_numberbatch_provider: Optional[Callable[[], Any]] = None


def set_numberbatch_provider(fn: Callable[[], Any]) -> None:
    """resources.py(分身B) 接线点：fn() 应返回 dict/Map 形状 {word: 300维向量} 或 None。"""
    global _numberbatch_provider
    _numberbatch_provider = fn


def get_numberbatch() -> Any:
    """[对照 numberbatch.mjs:getNumberbatch 消费语义] provider 未接线/失败 → None（下游按无向量退化）。"""
    if _numberbatch_provider is None:
        return None
    try:
        return _numberbatch_provider()
    except Exception as e:  # noqa: BLE001 — provider 崩不拖垮分词层，响亮记录
        print(f"[p1_res] numberbatch provider failed: {e}", file=sys.stderr)
        return None


# ════════════════════════════════════════════════════════════════════
# 缓存清理（对照 JS 各 clear*Caches 的资源侧部分）
# ════════════════════════════════════════════════════════════════════
def clear_node1_resource_caches() -> None:
    """[对照 p1_node1_tokenize.mjs:clearNode1TokenizeCaches 资源侧] THUOCL/否定词/英文表/HanLP。"""
    global _thuocl_prefix_idx, _negation_words, _en_lex, _hanlp_dict
    _thuocl_prefix_idx = None
    _negation_words = None
    _en_lex = None
    _hanlp_dict = None


def clear_node2_resource_caches() -> None:
    """[对照 p1_node2_swow.mjs:clearNode2SwowCaches] SWOW cue 字典/口语补集。"""
    global _swow_zh_cue_cache, _colloquial_noninfo
    _swow_zh_cue_cache = None
    _colloquial_noninfo = None


def clear_shared_resource_caches() -> None:
    """BCC/POS/停用词/SWOW 主库/同义索引（JS 侧无统一清理口，测试用）。"""
    global _bcc_dict, _jieba_pos_map, _stopwords, _swow_zh, _swow_en, _synonym_map, _res_dir
    _bcc_dict = None
    _jieba_pos_map = None
    _stopwords = None
    _swow_zh = None
    _swow_en = None
    _synonym_map = None
    _res_dir = None


def get_node1_resource_cache_stats() -> dict[str, Any]:
    """[对照 p1_node1_tokenize.mjs:getNode1TokenizeCacheStats 口径] loaded 计数 + buckets 总量。"""
    loaded = sum(1 for v in (_thuocl_prefix_idx, _negation_words, _en_lex, _hanlp_dict) if v is not None)
    en = _en_lex or {"stop": set(), "inten": set(), "neg": set()}
    buckets = (len(_thuocl_prefix_idx or {}) + len(_negation_words or set())
               + len(en["stop"]) + len(en["inten"]) + len(en["neg"]) + len(_hanlp_dict or {}))
    return {"loaded": loaded, "buckets": buckets}
