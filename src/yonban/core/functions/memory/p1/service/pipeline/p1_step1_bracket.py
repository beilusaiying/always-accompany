"""p1_step1_bracket.py — Step -1: 括号双信道前置层（JS 平移: p1/p1_step1_bracket.mjs）。

功能链：p1_pipeline_py → split_bracket_channels(text) → {main, sub, hasBracket, bracketCount}
why：括号是元语言符号，主副信道若取均值会抵消两轴张力（002 铁律）；
     格式性括号（序号/旁注）豁免，真情绪括号分离进副信道，分词前纯字符串切分零开销。
平移保真：PAREN_PATTERN / PAREN_BLACKLIST / _MIN_PAREN_LEN(env P1_BRACKET_MIN_LEN 默认4) /
     _SUB_SEP(env P1_BRACKET_SEP 默认" ") 逐项照抄；坑#2（豁免括号保留在主信道防内容丢失）已保留。
影响范围：纯字符串切分，无 I/O。
"""
from __future__ import annotations

import os
import re

try:
    from .p1_whitebox import trace
except ImportError:
    from p1_whitebox import trace

# 中英文括号 () （), 非贪婪整体捕获(不含内层括号字符)
PAREN_PATTERN = re.compile(r"[（(]([^（()）]+)[)）]")

# 豁免名单: 格式/序号/旁注/空（锚定 ^...$ 防子串污染）
PAREN_BLACKLIST = [
    re.compile(r"^#?\d+$"),            # 纯数字序号: (1) (2) (#1)
    re.compile(r"^\d+\.?\d*$"),        # 小数序号: (1.5)
    re.compile(r"^\s*$"),              # 空/空白占位: ( )
    re.compile(r"^[a-z]\d*$", re.I),   # 单字母标号: (A) (b1)
    re.compile(r"^ps\s*[:：]", re.I),  # 旁注: (ps: ...) (PS：...)
]

_MIN_PAREN_LEN = int(os.environ.get("P1_BRACKET_MIN_LEN") or 4)  # [魔法数字 — 待实验定]
_SUB_SEP = os.environ.get("P1_BRACKET_SEP") or " "

_WS_RE = re.compile(r"\s+")


def split_bracket_channels(text) -> dict:
    """Step -1 括号双信道切分（返回字段与 JS 逐字段一致）。"""
    if not text or not isinstance(text, str):
        return {"main": text or "", "sub": None, "hasBracket": False, "bracketCount": 0}

    # 快速路径: 无任何括号字符 → 零开销
    if "(" not in text and "（" not in text:
        trace("step1", lambda: {
            "input": {"textLen": len(text), "head": text[:40]},
            "process": "快速路径: 原文无括号字符 → 单信道直通(零副信道开销)",
            "output": {"hasBracket": False, "channel": "main=原文"},
            "reason": "indexOf('(')与('（')均为-1, 不进入括号扫描",
        })
        return {"main": text, "sub": None, "hasBracket": False, "bracketCount": 0}

    sub_parts: list[str] = []
    remove_spans: list[tuple[int, int]] = []
    verdicts: list[dict] = []
    for m in PAREN_PATTERN.finditer(text):
        inner = m.group(1).strip()
        bl_idx = next((i for i, bre in enumerate(PAREN_BLACKLIST) if bre.search(inner)), -1)
        if bl_idx != -1:
            verdicts.append({"inner": inner[:20], "verdict": f"豁免:格式黑名单#{bl_idx}(留主信道)"})
            continue
        if len(inner) < _MIN_PAREN_LEN:
            verdicts.append({"inner": inner[:20], "verdict": f"豁免:长度{len(inner)}<{_MIN_PAREN_LEN}(留主信道)"})
            continue
        verdicts.append({"inner": inner[:20], "verdict": "→副信道"})
        sub_parts.append(inner)
        remove_spans.append((m.start(), m.end()))

    if not sub_parts:
        trace("step1", lambda: {
            "input": {"textLen": len(text), "head": text[:40]},
            "process": f"扫描{len(verdicts)}个括号对, 全部豁免 → 单信道(豁免括号保留在主信道正文)",
            "output": {"hasBracket": False, "verdicts": verdicts},
            "reason": "每括号判定见 verdicts; 豁免≠剥除, 内容留在主信道防丢失(设计MD§10.1坑#2)",
        })
        return {"main": _WS_RE.sub(" ", text).strip(), "sub": None, "hasBracket": False, "bracketCount": 0}

    # 主信道 = 原文剥除"真进副信道的那些片段" + 空白归一
    main_parts = []
    cursor = 0
    for s, e in remove_spans:
        main_parts.append(text[cursor:s])
        cursor = e
    main_parts.append(text[cursor:])
    main = _WS_RE.sub(" ", "".join(main_parts)).strip()

    sub = _SUB_SEP.join(sub_parts)

    trace("step1", lambda: {
        "input": {"textLen": len(text), "head": text[:40]},
        "process": f"双信道拆分: 扫描{len(verdicts)}个括号对 → {len(sub_parts)}个进副信道, {len(verdicts) - len(sub_parts)}个豁免留主信道",
        "output": {"hasBracket": True, "bracketCount": len(sub_parts), "main": main[:60], "sub": sub[:60], "verdicts": verdicts},
        "reason": "主/副信道分开输出不取均值(002:反向情绪取均值会抵消张力); 每括号进/留判定见 verdicts",
    })
    return {"main": main, "sub": sub, "hasBracket": True, "bracketCount": len(sub_parts)}
