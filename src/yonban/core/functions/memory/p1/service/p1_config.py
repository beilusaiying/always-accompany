"""p1_config.py — P1 独立服务的自持配置（零本体依赖）。

功能链：
    p1_server.py 每请求 → get_config() → mtime 变了才重读盘 → 返回配置 dict
    setConfig action → update_config(patch) → 钳制 → 原子写盘（tmp+rename）

why 自持而不读本体插件目录：002 0731 架构拍板"除了前端需要依赖,其他如果需要依赖那么就是高耦合"
    ——P1 是核心功能层，配置/数据路径全部自己管。迁移旧值是部署动作（migrate_from 一次性），非运行依赖。
影响范围：service 内唯一配置入口；DEFAULTS 键集与旧插件 defaults 对齐（0731 全部定档值），
    前端参数面板经薄壳 getConfig/setConfig 消费同一键集，前端零改动。
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from p1_paths import HOST_USERS_ROOT, RESOURCE_ROOT, SETTINGS_ROOT, STORAGE_ROOT, user_state_root

SERVICE_DIR = Path(__file__).resolve().parent
# Backward-compatible export name. It now points at authoritative P1 storage,
# never at code/service/data and never at the host's disposable data tree.
DATA_DIR = STORAGE_ROOT
CONFIG_FILE = SETTINGS_ROOT / "service.json"

# 路径类配置默认值：初始部署便利指向现有资源位置（可在 config.json 覆盖，属部署配置非代码依赖）。
DEFAULTS: dict[str, Any] = {
    # ── 服务 ──
    "port": 13150,                 # 仅绑 127.0.0.1
    "enabled": True,
    # 用户要求每次本地召回低于 1s；重资源若按空闲定时停机会把 20s+ 冷启动
    # 重新压到下一条真实消息，因此框架默认常驻。仍保留可配置的手动空闲停机。
    "idleShutdownSec": 0,         # 无 runP1 活动 N 秒后停止整个 P1 进程树；0=常驻
    # ── 路径（P1 自己的数据版图；迁移后可指任意位置）──
    "resourceDir": str(RESOURCE_ROOT),                  # P1 唯一资源根
    "dataRoot": str(HOST_USERS_ROOT),                  # 仅作宿主记忆默认读根，P1 不在此写状态
    # ── P1v2 白盒新管线键(0801;node 侧 config_map.mjs 白名单消费,红线参数不进配置面) ──
    "engine": "node",          # runP1 引擎: node=白盒新管线 / python=旧管线(回退通道)
    "dataCount": 2,            # data 最近 N 条进召回语境(凛倾原话"data最近2个")
    "inputMaxWords": 80,       # 分词后词数截断上限(凛倾原话"80词",与 inputMaxChars 字符口径并存)
    "truncHeadRatio": 0.5,     # 截断头段占比(0731 A/B 有 0.3 档数据)
    "concFloor": 2.0,          # 中文具体性下限
    "enConcFloor": 2.0,        # 英文具体性下限
    "enFreqHigh": 0,           # ECDICT 高频排除线(0=只标注不过滤)
    "englishPosBackend": "wordnet",  # wordnet=2GB预算默认 / stanza=显式重后端 / none=不标词性
    "swowTopK": 6,             # SWOW 每词联想数
    "swowMinSupZh": 1,         # SWOW 中文多词支持度(0801 白盒定档 2→1)
    "cnTopK": 10,              # ConceptNet 每词每关系取前 K
    "cilinMaxL3": 2,           # 词林同小类扩展上限(0801 白盒定档)
    "cilinMaxL2": 0,           # 词林同中类扩展上限(0801 白盒定档: 默认关,噪声源)
    "atomicTopK": 6,           # ATOMIC 每词事件推理数
    "ibAlpha": 2.0,            # IB 倒U α
    "hitWeight": 0.5,          # 关联词每命中加分
    "phraseWeight": 0.3,       # 短语匹配加分
    "phraseMinRun": 3,         # 连续 token 命中≥N 算短语
    "topInputBonus": 0.2,      # top 词命中额外加成
    "ctxWordsPerUnit": 2,      # 上下文/data 每条取 N 词做锚(凛倾锁定值"取2词")
    "mechDisable": "",         # 发散机制关停(逗号分隔: swow_zh,conceptnet_zh,cilin,swow_en,atomic,conceptnet_en)
    "fusion": "weighted",      # 排序融合: weighted / rrf
    "experimentLog": True,     # 实验储存: 每次召回结果独立落盘 JSONL(展示+问题收集,不存对话)
    "vocabDir": str(STORAGE_ROOT / "vocab"),          # 无用户身份时的全局词库兜底
    # ── 召回参数（0731 定档全集，语义与数值对照旧插件 defaults 注释）──
    "dataRecall": True,
    "entryTopK": 20,
    "resonanceW": 0,
    "combinedMin": 4,
    "nbGlobalRoute": False,
    "deferNb300": True,
    "nbRerank": True,
    "sparseTopK": 100,
    "bm25K1": 1.2,
    "bm25B": 0.75,
    "termTopK": 6,
    "contextMessages": 5,          # 当前输入单列；最近5条 user 作为上下文，assistant 不进召回单元
    "inputMaxChars": 80,
    "shortSegmentChars": 10,
    "copyJaccardThreshold": 0.7,  # Node0 字符 bigram 复制排除阈值；待实验定档，默认保留原行为
    "excludeExactAssistantCopies": True,
    "recentDataTopK": 0,           # [0731 002拍板 5→0] 回填消融：英文+11pp/冻结解除，中文-1pp
    "recordTopK": 5,
    "candidateMinHits": 2,         # [0731 002确认恒2演进默认] Python管线用;Node管线用 shortInputChars+hitsDivisor
    "shortInputChars": 12,         # 短输入门槛(字): 输入<此值时 minHits=1 宽松召回
    "hitsDivisor": 10,             # 标准门槛除数: 每N字需1命中; 调大更宽松
    "layerWeightHot": 1.0,         # [0731 配置通道] 记忆层排序权重，默认=原硬编码零行为变化
    "layerWeightWarm": 0.85,
    "layerWeightCold": 0.7,
    "collapseSameFileKeywordSet": True,
    "snippetMaxChars": 240,
    "injectMaxChars": 0,           # 输出线：0=不限
    "recencyDecayBase": 0.995,
    "blqRerank": False,
    "includeMarkdown": True,
    "memoryFileMaxBytes": 8 * 1024 * 1024,  # 单个记忆源读取上限；超过时必须返回 diagnostics
    "indexCacheMax": 8,
    "nbCacheMaxVectors": 50000,
    # ── Node 管线打分/排序参数（config_map.mjs 消费，前端面板可调）──
    "oovBonus": 0.5,               # OOV 专名命中加分；消费方=node4_rank.mjs OOV_BONUS
    "exactAnchorBonus": 0.75,      # 专名/metadata keyword 精确直达候选加分
    "timeMatchBonus": 0.8,         # 显式时间锚与记录事件时间/文件日期匹配加分
    "recordTopBonus": 1.0,         # 记录 pinned/top 的独立加分（不同于发散词 top）
    "recordImportanceWeight": 0.5, # 记录 weight/importance(0..1) 的加权系数
    "anchorTopN": 30,              # 发散池取前 N 个做查询词；消费方=node4_rank.mjs ANCHOR_TOPN
    "topBonusN": 10,               # top 加分候选数；消费方=node4_rank.mjs TOP_BONUS_N
    "nbDedupThreshold": 0.85,      # 候选词对 cosine 超过此值视为近义；消费方=NB_DEDUP_THRESH
    "emotionBonusW": 0.1,          # 情绪标注加成系数；消费方=node3_score.mjs EMOTION_BONUS_W
    "domainBonusW": 0.2,           # 术语域加成系数；消费方=node3_score.mjs DOMAIN_BONUS_W
    "poolStrengthW": 0.3,          # 池 CombSUM 加成系数；消费方=node3_score.mjs POOL_STRENGTH_W
    "conc78kPenaltyThresh": 2.5,   # 具体性惩罚阈值(1-5)；消费方=node3_score.mjs CONC78K_PENALTY_THRESH
    "conc78kPenaltyW": 0.3,        # 具体性惩罚系数；消费方=node3_score.mjs CONC78K_PENALTY_W
    "blqScoreFloor": 0.1,          # BLQ 最低分截断线；score<此值丢弃；消费方=node3_score.mjs BLQ_SCORE_FLOOR
    "wnDualFloor": 0.1,            # WordNet 双重验证阈值；NB cos 和 WN sim 都>此值才保留；消费方=node3_score.mjs WN_DUAL_FLOOR
    # ── P9 词库维护 ──
    "vocabEditMaxChanges": 30,     # <vocab_edit> 单次改动条数熔断（防 AI 失控大改）；消费方=本体 vocabEditExec 经 getConfig 拉取
    # ── AT 词库检索/浏览（0731 机制类硬编码收口，默认值=原硬编码值，零行为变化）──
    "atSearchMaxHits": 50,         # atSearch 命中数硬上限；消费方=p1_server.py at_search()
    "atBrowseLimitDefault": 50,    # atBrowse 分页每页默认条数；消费方=p1_server.py at_browse() + 前端 p1panel.mjs atBrowse 请求
    "atBrowseLimitMax": 200,       # atBrowse 分页每页条数硬上限；消费方=p1_server.py at_browse()
    # ── 打字式联想（前端 typingSuggest.mjs 经 getData 拉取，拉不到用前端现值兜底）──
    "typingDebounceMs": 400,       # 输入防抖延迟(ms)；消费方=typingSuggest.mjs onTypingInput
    "typingMinChars": 4,           # 触发联想最小字数；消费方=typingSuggest.mjs onTypingInput
    # ── 运行记录（0731 002"每次输出都需要进行文件记录"）──
    "runLogEnabled": True,         # 每次真实召回输出落盘 JSONL（storage/p1 用户状态根）；打字联想轻量路不记
    "runLogKeepDays": 30,          # 记录保留天数；0=永久保留；消费方=p1_server.py _prune_run_logs
}

# (min, max, is_int) 钳制表——与旧插件 _numberInRange 逐键一致
_RANGES: dict[str, tuple[float, float, bool]] = {
    "port": (1024, 65535, True),
    "entryTopK": (5, 50, True),
    "resonanceW": (0, 2, False),
    "combinedMin": (2, 10, False),
    "sparseTopK": (20, 500, True),
    "bm25K1": (0.1, 3, False),
    "bm25B": (0, 1, False),
    "termTopK": (1, 20, True),
    "contextMessages": (0, 5, True),
    "inputMaxChars": (20, 500, True),
    "shortSegmentChars": (1, 80, True),
    "copyJaccardThreshold": (0, 1, False),
    "recentDataTopK": (0, 50, True),
    "recordTopK": (1, 50, True),
    "candidateMinHits": (2, 8, True),
    "layerWeightHot": (0, 2, False),
    "layerWeightWarm": (0, 2, False),
    "layerWeightCold": (0, 2, False),
    "snippetMaxChars": (40, 2000, True),
    "injectMaxChars": (0, 20000, True),
    "recencyDecayBase": (0.9, 1, False),
    "memoryFileMaxBytes": (64 * 1024, 64 * 1024 * 1024, True),
    "indexCacheMax": (1, 64, True),
    "nbCacheMaxVectors": (0, 200000, True),
    "oovBonus": (0, 3, False),
    "exactAnchorBonus": (0, 5, False),
    "timeMatchBonus": (0, 5, False),
    "recordTopBonus": (0, 5, False),
    "recordImportanceWeight": (0, 5, False),
    "anchorTopN": (5, 100, True),
    "topBonusN": (1, 50, True),
    "nbDedupThreshold": (0, 1, False),
    "emotionBonusW": (0, 2, False),
    "domainBonusW": (0, 2, False),
    "poolStrengthW": (0, 2, False),
    "conc78kPenaltyThresh": (1, 5, False),
    "conc78kPenaltyW": (0, 2, False),
    "blqScoreFloor": (0, 5, False),
    "wnDualFloor": (0, 1, False),
    "vocabEditMaxChanges": (1, 200, True),
    "atSearchMaxHits": (1, 500, True),
    "atBrowseLimitDefault": (1, 200, True),
    "atBrowseLimitMax": (50, 1000, True),
    "typingDebounceMs": (100, 3000, True),
    "typingMinChars": (1, 20, True),
    "runLogKeepDays": (0, 3650, True),
    "idleShutdownSec": (0, 3600, True),
}
_CHOICES: dict[str, set[str]] = {
    "engine": {"node", "python"},
    "fusion": {"weighted", "rrf"},
    "englishPosBackend": {"wordnet", "stanza", "none"},
}

_config: dict[str, Any] = dict(DEFAULTS)
_config_mtime: float = -1.0


def _clamp(key: str, value: Any) -> Any:
    if key in DEFAULTS and value is None:
        return DEFAULTS[key]
    if key in _CHOICES:
        if not isinstance(value, str):
            return DEFAULTS[key]
        normalized = value.strip().lower()
        return normalized if normalized in _CHOICES[key] else DEFAULTS[key]
    if key not in _RANGES:
        return value
    lo, hi, is_int = _RANGES[key]
    try:
        n = float(value)
    except (TypeError, ValueError):
        return DEFAULTS[key]
    n = max(lo, min(hi, n))
    return int(n) if is_int else n


def get_config() -> dict[str, Any]:
    """mtime 变化才重读盘；盘不存在 = 代码默认（合法路径，不报错）。"""
    global _config_mtime, _config
    try:
        mt = CONFIG_FILE.stat().st_mtime
    except OSError:
        return _config
    if mt == _config_mtime:
        return _config
    _config_mtime = mt
    try:
        loaded = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"P1 service config is unreadable: {CONFIG_FILE}: {error}") from error
    if not isinstance(loaded, dict):
        raise RuntimeError(f"P1 service config must be a JSON object: {CONFIG_FILE}")
    merged = dict(DEFAULTS)
    merged.update(loaded)
    for k in list(merged):
        merged[k] = _clamp(k, merged[k])
    _config = merged
    return _config


SERVICE_KEYS = frozenset({"port", "enabled", "idleShutdownSec", "resourceDir", "dataRoot", "vocabDir"})


def get_user_config(username: str) -> dict[str, Any]:
    """用户级配置覆盖: 全局 config ← 用户 overlay。服务级键(port/enabled/路径)不允许覆盖。"""
    base = dict(get_config())
    if not username:
        return base
    user_cfg_path = user_state_root(username) / "settings.json"
    if user_cfg_path.exists():
        try:
            loaded = json.loads(user_cfg_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"P1 user config is unreadable: {user_cfg_path}: {error}") from error
        if not isinstance(loaded, dict):
            raise RuntimeError(f"P1 user config must be a JSON object: {user_cfg_path}")
        for k, v in loaded.items():
            if k in SERVICE_KEYS or k not in DEFAULTS:
                continue
            base[k] = _clamp(k, v)
    return base


def update_user_config(username: str, patch: dict[str, Any]) -> dict[str, Any]:
    """写用户级参数覆盖(不动全局 config)。"""
    if not username:
        return update_config(patch)
    base = get_config()
    user_cfg_path = user_state_root(username) / "settings.json"
    if user_cfg_path.exists():
        try:
            existing = json.loads(user_cfg_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"P1 user config is unreadable: {user_cfg_path}: {error}") from error
        if not isinstance(existing, dict):
            raise RuntimeError(f"P1 user config must be a JSON object: {user_cfg_path}")
    else:
        existing = {}
    for k, v in patch.items():
        if k in SERVICE_KEYS or k not in DEFAULTS:
            continue
        existing[k] = _clamp(k, v)
    user_cfg_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(user_cfg_path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(existing, f, ensure_ascii=False, indent=2)
        os.replace(tmp, user_cfg_path)
    except OSError:
        try: os.unlink(tmp)
        except OSError: pass
        raise
    return get_user_config(username)


def update_config(patch: dict[str, Any]) -> dict[str, Any]:
    """浅合并已知键（未知键拒收防脏写）→ 钳制 → 原子写盘。"""
    cfg = dict(get_config())
    for k, v in patch.items():
        if k not in DEFAULTS:
            continue
        cfg[k] = _clamp(k, v)
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(CONFIG_FILE.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_FILE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    global _config, _config_mtime
    _config = cfg
    _config_mtime = CONFIG_FILE.stat().st_mtime
    return cfg
