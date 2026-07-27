# -*- coding: utf-8 -*-
"""
themes.py —— 主题预设库（v0.5）

来源: anthropics/skills pptx SKILL.md 的 10 组官方色板（原文 Primary/Secondary/Accent），
映射到本管线 theme 四色约定（title/body/bg/accent, hex 无#）。
spec 的 meta.theme 可为: dict(自定义) | 预设名字符串 | None(黑白)。
映射原则: 深色做 title、浅色做 bg、中间色做 accent；body 统一深灰保证 WCAG 正文对比度。
"""

PRESETS = {
    "midnight_executive": {"title_color": "1E2761", "body_color": "2B2B2B",
                           "bg_color": "FFFFFF", "accent_color": "1E2761",
                           "cover_title_color": "FFFFFF"},
    "forest_moss":        {"title_color": "2C5F2D", "body_color": "2B2B2B",
                           "bg_color": "F5F5F5", "accent_color": "97BC62",
                           "cover_title_color": "F5F5F5"},
    "coral_energy":       {"title_color": "2F3C7E", "body_color": "2B2B2B",
                           "bg_color": "FFFFFF", "accent_color": "F96167",
                           "cover_title_color": "FFFFFF"},
    "warm_terracotta":    {"title_color": "B85042", "body_color": "2B2B2B",
                           "bg_color": "E7E8D1", "accent_color": "A7BEAE",
                           "cover_title_color": "FFFFFF"},
    "ocean_gradient":     {"title_color": "21295C", "body_color": "2B2B2B",
                           "bg_color": "FFFFFF", "accent_color": "1C7293",
                           "cover_title_color": "FFFFFF"},
    "charcoal_minimal":   {"title_color": "212121", "body_color": "36454F",
                           "bg_color": "F2F2F2", "accent_color": "36454F",
                           "cover_title_color": "F2F2F2"},
    "teal_trust":         {"title_color": "028090", "body_color": "2B2B2B",
                           "bg_color": "FFFFFF", "accent_color": "02C39A",
                           "cover_title_color": "FFFFFF"},
    "berry_cream":        {"title_color": "6D2E46", "body_color": "2B2B2B",
                           "bg_color": "ECE2D0", "accent_color": "A26769",
                           "cover_title_color": "ECE2D0"},
    "sage_calm":          {"title_color": "50808E", "body_color": "2B2B2B",
                           "bg_color": "FFFFFF", "accent_color": "84B59F",
                           "cover_title_color": "FFFFFF"},
    "cherry_bold":        {"title_color": "990011", "body_color": "2B2B2B",
                           "bg_color": "FCF6F5", "accent_color": "2F3C7E",
                           "cover_title_color": "FCF6F5"},
    # ---- v1.8: 真实优秀模板提炼（0717 采集 11 个 pptx 的 theme1.xml clrScheme,
    #      来源见 参考项目\ppt模板示例\ + exp_优秀模板采集.md; 映射原则同上）----
    "ion_boardroom":      {"title_color": "3B3059", "body_color": "2B2B2B",   # 微软 Ion 暖洋红
                           "bg_color": "FFFFFF", "accent_color": "B31166",
                           "cover_title_color": "FFFFFF"},
    "gbif_nature":        {"title_color": "231F20", "body_color": "2B2B2B",   # GBIF 学术绿
                           "bg_color": "FFFFFF", "accent_color": "61A150",
                           "cover_title_color": "FFFFFF"},
    "urban_earth":        {"title_color": "4A5356", "body_color": "2B2B2B",   # Urban 低饱和大地
                           "bg_color": "E8E3CE", "accent_color": "E6A02E",
                           "cover_title_color": "E8E3CE"},
    "teal_stage":         {"title_color": "005C69", "body_color": "2B2B2B",   # lrkrol 深青玫红
                           "bg_color": "FFFFFF", "accent_color": "D73371",
                           "cover_title_color": "FFFFFF"},
    "lastig_academic":    {"title_color": "215CAF", "body_color": "2B2B2B",   # LASTIG 学术蓝青
                           "bg_color": "FFFFFF", "accent_color": "007894",
                           "cover_title_color": "FFFFFF"},
    "office_minimal":     {"title_color": "44546A", "body_color": "2B2B2B",   # 微软 Minimalist 橙
                           "bg_color": "FFFFFF", "accent_color": "ED7D31",
                           "cover_title_color": "FFFFFF"},
    # ---- v1.9: ppt-master 内容层配色提炼（theme1.xml 是 Office 默认, 精华在 slide 页面级填充,
    #      分身解析 slideN.xml 频次+语境判读, 见 code_pptmaster内容层配色.md）----
    "capital_night":      {"title_color": "E8E6E1", "body_color": "A9A49D",   # 数据资本暗夜+品牌红
                           "bg_color": "0E1116", "accent_color": "E63946",
                           "cover_title_color": "E8E6E1"},
    "magazine_bold":      {"title_color": "111111", "body_color": "2B2B2B",   # 杂志黑白+杂志红
                           "bg_color": "FFFFFF", "accent_color": "C8102E",
                           "cover_title_color": "FFFFFF"},
}


import os as _os
import json as _json
import sys as _sys


def load_overlay():
    """
    v1.9 数据覆盖层（凛倾 0717"不要硬编码, 预设要可编辑"）: 色板/风格包改 JSON 即生效, 零代码。
    结构 {"presets": {名: 四色dict}, "style_packs": {名: pack dict}}——同名覆盖内置, 新名扩展。
    源优先级: env BEILU_PPT_THEMES（JS 侧 settings.themesFile / data/beilu-ppt-themes.json 传导,
    范式同素材库 env）> 管线目录 themes_custom.json（CLI 独立跑的本地覆盖）。
    坏 JSON → stderr 警告不阻断（离线硬约束: 覆盖层损坏不死内核, 退内置默认）。
    """
    cands = (_os.environ.get("BEILU_PPT_THEMES"),
             _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "themes_custom.json"))
    for p in cands:
        if p and _os.path.isfile(p):
            try:
                with open(p, encoding="utf-8") as f:
                    d = _json.load(f)
                if isinstance(d, dict):
                    return d
            except Exception as e:
                print("[themes] 覆盖层 %s 解析失败(忽略, 用内置默认): %s" % (p, e), file=_sys.stderr)
    return {}


_OVERLAY = load_overlay()
PRESETS.update({str(k).lower(): v for k, v in (_OVERLAY.get("presets") or {}).items()
                if isinstance(v, dict)})


def resolve_theme(theme):
    """dict 原样; 字符串查预设(未知名返回 None+由上游发信号); None 保持 None。"""
    if theme is None or isinstance(theme, dict):
        return theme
    return PRESETS.get(str(theme).lower())
