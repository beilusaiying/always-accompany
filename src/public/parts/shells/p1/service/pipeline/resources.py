"""resources.py — P1 Python 服务的词库/资源装载器（分身B 范围：召回层所需部分）。

功能链：
    p1_node0_anchor / p1_node0_data_recall → run_step1_extract(text) → {words, text}（记忆条目/ctx 句分词）
    p1_node0_data_recall → get_bcc_freq(word) → BCC 频率（DF/BCC 软降权）
    p1_recall → resolve_resource("linguistic_signals.json")
    p1_pipeline_py → get_memory_dir(username, char_name) → data/users/<u>/chars/<c>/memory

平移出处（JS 源，逐函数对照，禁自创）：
    run_step1_extract / _get_bcc_dict / get_bcc_freq ← memory/test/selfDrivenP1_utils.mjs
        （runStep1Extract L148-183 / _getBccDict L35-54 / _getBccFreq L55；jieba-wasm cut(text,true)
         → python jieba.cut(text)（HMM 默认开），词典差异属设计 MD 平移规则2 的"双跑容忍度"范畴）
    resolve_resource ← selfDrivenP1_utils.resolveResource + p1/p1_resdir.mjs（候选序 env > 随代码 > 旧运行位）
    get_memory_dir ← storage_mod/storage.mjs getMemoryDir（SEC-T2 charName 限制在本用户 chars 内）

资源根单源：p1_config.get_config()["resourceDir"]（002 拍板 P1 自持配置，默认指向现盘
    src/yonban/core/functions/memory；迁移后可改 config.json，代码零改动）。
影响范围：纯只读加载 + 进程内缓存；不写任何文件。
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

_SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
from p1_config import get_config  # noqa: E402  (service/p1_config.py, 主AI已落盘)

# 旧运行位（历史兼容，同 p1_resdir.mjs CANDIDATES 第三候选）
_LEGACY_RES_DIR = r"<local-dev-path>"


def get_memory_lib_dir() -> Path:
    """词库资源根（=JS 的 memory/ 目录），单源自 p1_config resourceDir。"""
    return Path(get_config()["resourceDir"])


def resolve_resource(filename: str) -> Path | None:
    """selfDrivenP1_utils.resolveResource 平移：memory 根 → memory/resources → p1_resdir 候选链。"""
    mem = get_memory_lib_dir()
    candidates = [
        mem / filename,
        mem / "resources" / filename,
    ]
    env_dir = os.environ.get("P1_RESOURCE_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / filename)
    candidates.append(mem / "p1_res" / filename)
    candidates.append(Path(_LEGACY_RES_DIR) / filename)
    for p in candidates:
        try:
            if p.exists():
                return p
        except OSError:
            continue
    return None


# ── BCC 频率词典（multi_domain_total_word_freq.txt → dict[str,int]）──
# 单源优先: 分身A resources_node1.get_bcc_dict 已就绪时直接复用（同一 5MB 词典不双份常驻——002 内存关切）；
# 缺席时才走本文件同款解析 fallback（两份解析逐行对照 JS _getBccDict，语义一致）。
try:
    from resources_node1 import get_bcc_dict as _node1_get_bcc_dict  # type: ignore
except ImportError:
    _node1_get_bcc_dict = None

_bcc_dict_cache: dict[str, int] | None = None

_INT_HEAD_RE = re.compile(r"^\s*[+-]?\d+")  # JS parseInt 语义: 前缀整数, 其余忽略


def _parse_int_js(s: str) -> int | None:
    m = _INT_HEAD_RE.match(s)
    if not m:
        return None
    try:
        return int(m.group(0))
    except ValueError:
        return None


def _get_bcc_dict() -> dict[str, int]:
    global _bcc_dict_cache
    if _node1_get_bcc_dict is not None:
        return _node1_get_bcc_dict()  # 单源复用（见上注释）
    if _bcc_dict_cache is not None:
        return _bcc_dict_cache
    _bcc_dict_cache = {}
    try:
        f = resolve_resource("multi_domain_total_word_freq.txt")
        if f is None:
            return _bcc_dict_cache
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            for i, raw in enumerate(fh):
                line = raw.strip()
                if not line or (i == 0 and line.startswith("token")):
                    continue
                sep = "\t" if "\t" in line else ","
                idx = line.rfind(sep)
                if idx < 0:
                    continue
                w = line[:idx].strip()
                freq = _parse_int_js(line[idx + 1:])
                if w and freq is not None:
                    _bcc_dict_cache[w] = freq
    except OSError:
        _bcc_dict_cache = {}
    return _bcc_dict_cache


def get_bcc_freq(w: str) -> int:
    """_getBccFreq 平移：查无 → 0。"""
    return _get_bcc_dict().get(w, 0)


# ── runStep1Extract 平移（记忆条目/ctx 句分词，与 node0 同口径）──
_jieba_cut = None
_jieba_tried = False

_ASCII_HEAD_RE = re.compile(r"^[a-zA-Z]")
_CJK_HEAD_RE = re.compile(r"^[\u4e00-\u9fff]")
_CJK_SEG_RE = re.compile(r"[\u4e00-\u9fff]+")
_EN_SEG_RE = re.compile(r"[a-zA-Z]{2,}")


def _get_jieba_cut():
    """懒加载 jieba（对应 JS 顶层 `await import("jieba-wasm")` try/catch：缺 jieba 走贪心 fallback）。"""
    global _jieba_cut, _jieba_tried
    if _jieba_tried:
        return _jieba_cut
    _jieba_tried = True
    try:
        import jieba  # type: ignore

        jieba.setLogLevel(60)  # 静默初始化日志（不改分词行为）
        _jieba_cut = jieba.cut
    except ImportError:
        _jieba_cut = None
    return _jieba_cut


def run_step1_extract(text: str) -> dict:
    """runStep1Extract 平移：jieba 分词 → 去重保序 → ASCII 开头词直收 / CJK 词 BCC freq>500000 剔除。

    jieba-wasm cut(text, true)=HMM 开 ↔ python jieba.cut(text)（HMM 默认 True）。
    fallback（无 jieba）：BCC 贪心最长匹配（len 4→2）+ 英文 [a-zA-Z]{2,}，逐行对照 JS L164-181。
    """
    if not text:
        return {"words": [], "text": ""}
    seen: set[str] = set()
    words: list[str] = []
    cut = _get_jieba_cut()
    if cut is not None:
        for w in cut(text):
            if len(w) < 2:
                continue
            if w in seen:
                continue
            if _ASCII_HEAD_RE.match(w):
                words.append(w)
                seen.add(w)
                continue
            if _CJK_HEAD_RE.match(w):
                freq = get_bcc_freq(w)
                if freq > 500000:
                    continue
                words.append(w)
                seen.add(w)
    else:
        zh_segs = _CJK_SEG_RE.findall(text)
        en = _EN_SEG_RE.findall(text)
        for seg in zh_segs:
            pos = 0
            while pos < len(seg):
                best = None
                best_len = 1
                best_freq = 0
                for ln in range(min(4, len(seg) - pos), 1, -1):
                    w = seg[pos:pos + ln]
                    f = get_bcc_freq(w)
                    if f > 0 and (ln > best_len or (ln == best_len and f > best_freq)):
                        best = w
                        best_len = ln
                        best_freq = f
                if best is not None and best_freq > 0:
                    if best not in seen:
                        words.append(best)
                        seen.add(best)
                    pos += best_len
                else:
                    pos += 1
        for w in en:
            if w not in seen:
                words.append(w)
                seen.add(w)
    return {"words": words, "text": text}


# ── 具体度词库（wordCoords.mjs _loadConcreteness/getConcreteness 平移）──
# 消费方: p1_node0_anchor（concBonus 白盒 _conc 字段；P1_N0_CONCRETE 默认 off, bonus 恒 0）。
# 优先级同 JS: concreteness_78k.json(87942 词) > concreteness_zh.json(Gemini 补充) >
#             RES_DIR/brysbaert_concreteness.txt(英文, tab 分列 parts[2])。
_conc_map: dict[str, float] | None = None


def get_concreteness(word: str):
    global _conc_map
    if _conc_map is None:
        _conc_map = {}
        mem = get_memory_lib_dir()
        try:
            data = json.loads((mem / "concreteness_78k.json").read_text(encoding="utf-8"))
            for w, v in data.items():
                _conc_map[w] = v
        except (OSError, ValueError):
            pass
        try:
            data = json.loads((mem / "concreteness_zh.json").read_text(encoding="utf-8"))
            for w, v in data.items():
                _conc_map.setdefault(w, v)
        except (OSError, ValueError):
            pass
        en_file = resolve_resource("brysbaert_concreteness.txt")
        if en_file is not None:
            try:
                lines = en_file.read_text(encoding="utf-8").split("\n")
                for line in lines[1:]:
                    parts = line.split("\t")
                    if len(parts) >= 3:
                        w = parts[0].lower().strip()
                        try:
                            c = float(parts[2])
                        except ValueError:
                            continue
                        if w:
                            _conc_map.setdefault(w, c)
            except OSError:
                pass
    return _conc_map.get(word)  # 未收录 → None（JS ?? null 同款）


# ── 记忆目录解析（storage.mjs getMemoryDir 平移，SEC-T2 路径穿越防护）──
def get_memory_dir(username: str, char_name: str) -> str:
    """data/users/<u>/chars/<c>/memory；charName 不可信 → 限制在本用户 chars 目录内。"""
    data_root = Path(get_config()["dataRoot"])
    chars_root = (data_root / str(username or "") / "chars").resolve()
    char_dir = (chars_root / str(char_name if char_name is not None else "")).resolve()
    try:
        char_dir.relative_to(chars_root)  # confinePath 语义: 逃出 chars 根 → 拒绝
    except ValueError:
        raise ValueError(f"charName escapes chars root: {char_name!r}")
    return str(char_dir / "memory")


# ── 缓存生命周期（对应 clearSelfDrivenP1UtilsCaches 的 BCC 部分）──
def get_resources_cache_stats() -> dict:
    return {
        "bccDelegated": _node1_get_bcc_dict is not None,  # True=单源在 resources_node1(由其 clear 管理)
        "bccLoaded": _bcc_dict_cache is not None,
        "bccTerms": len(_bcc_dict_cache) if _bcc_dict_cache else 0,
        "concLoaded": _conc_map is not None,
        "concTerms": len(_conc_map) if _conc_map else 0,
        "jiebaLoaded": _jieba_cut is not None,
    }


def clear_resources_caches() -> dict:
    """清本文件缓存（BCC fallback 副本 + 具体度）；jieba 词典由 jieba 库自管理（进程级单例，
    同 JS node1 自管理语义）；BCC 单源副本（resources_node1）由其 clear_node1_resource_caches 管理。"""
    global _bcc_dict_cache, _conc_map
    before = get_resources_cache_stats()
    _bcc_dict_cache = None
    _conc_map = None
    return before
