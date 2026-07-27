# -*- coding: utf-8 -*-
"""
tokens.py —— v3 设计令牌单源（凛倾 0717"为什么会有那么多硬编码"）

职责: 视觉域全部数值/色彩/图层常量的唯一产地。compose.py（场景构造）从这里取值；
改一处全局生效。solver 的【文本几何】常量不在此（TITLE_X/BODY_SIZES 等留在 solver——
几何域与视觉域分治, solver 是保留的真资产不动）。
功能链: compose.py → tokens → scene 元素参数 → png_paint/pptx_paint 原样消费
"""

# ---- 图层 z 序（回答"图层位置有没有": 有, 且显式）----
LAYER_Z = {
    "background": 0,    # 页底色/渐变/整页背景图
    "decoration": 10,   # deco 装饰/卡片底/accent竖条/divider色带/title_rule
    "content": 20,      # 文字/图片/表格/图表/图解
    "widget": 30,       # 小配件（badge/progress/rating, 阶段2）
    "annotation": 40,   # 页脚/页码/大页码/溢出标记
}
LAYER_ORDER = ("background", "decoration", "content", "widget", "annotation")

# ---- 字阶（pt; 数组=降级链）----
TYPE_SCALE = {
    "footer": 9,
    "edge_label": 9,       # diagram 边标签
    "chart_value": 9,      # 柱顶数值标注
    "chart_legend": 10,
    "diagram_sub": 10,
    "chart_cat": 11,
    "caption": 11,         # 图注/表注
    "stat_label": 14,
    "image_label": 14,     # 占位框标注
    "cover_sub": 20,
    "quote_attr": 16,
    "overflow_mark": 20,
    "divider_title": 34,
    "big_page": 44,
    "cover_main": 44,      # 起点, 超宽 -4 逐级降
    "divider_num": 96,
    "hero_title": [54, 44, 36],
    "quote_text": [32, 28, 24],
}

# ---- 间距/几何（英寸）----
SPACING = {
    "page_margin_x": 0.6,
    "footer_y_from_bottom": 0.35,
    "footer_h": 0.25,
    "footer_page_w": 0.8,
    "footer_title_w": 4.0,
    "bigpage_from_right": 1.5,
    "bigpage_y": 0.25,
    "bigpage_w": 1.4,
    "bigpage_h": 0.9,
    "title_bar_w": 0.07,       # 标题左 accent 竖条宽
    "title_bar_dx": 0.16,      # 竖条相对标题 box 的左偏
    "title_bar_pad_y": 0.12,
    "card_bar_w": 0.055,       # 卡片左竖条宽
    "rule_h_emu": 6350,        # ~0.5pt 细线高
    "caption_gap": 0.05,
    "caption_h": 0.3,
    "divider_band_min_h": 2.2,
    "divider_band_pad": 0.35,
    "divider_card_ratio": 1 / 3,
    "table_cell_margin": 0.06,
    "diagram_node_line_pt": 1.25,
    "diagram_edge_line_pt": 1.75,
    "hero_margin_x": 1.0,
}

# ---- 色彩语义（hex 不带 #; 比率=与底色混合系数）----
COLOR = {
    "default_accent": "4472C4",
    "white": "FFFFFF",
    "gray_text": "666666",
    "gray_footer": "999999",
    "gray_rule": "CCCCCC",
    "gray_fill": "DDDDDD",
    "overflow_mark": "CC3333",
    "card_tint_ratio": 0.07,     # bullets/text 卡片底
    "stat_tint_ratio": 0.10,     # stat 卡片底
    "table_band_ratio": 0.06,    # 斑马纹
    "diagram_tint_ratio": 0.10,  # diagram 节点底
    "bigpage_sat": 0.25,         # 大页码淡化(25%色+75%白)
    "dark_bg_lum": 0.45,         # 深底判定阈值(WCAG 相对亮度)
}


def hex_rgb(h, default=None):
    """'RRGGBB'(容错带#) → (r,g,b) 或 default。全库色值解析单源。"""
    if not h or not isinstance(h, str):
        return default
    h = h.lstrip("#").strip()
    if len(h) != 6:
        return default
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return default


def rgb_hex(rgb):
    return "%02X%02X%02X" % tuple(int(c) for c in rgb)


def mix(hex_a, hex_b, ratio):
    """a×ratio + b×(1-ratio)（tint/淡化单源: 卡片底=mix(accent,bg,0.07)）。"""
    a = hex_rgb(hex_a, (0, 0, 0))
    b = hex_rgb(hex_b, (255, 255, 255))
    return rgb_hex(tuple(a[i] * ratio + b[i] * (1 - ratio) for i in range(3)))


def luminance(h):
    """WCAG 2.x 相对亮度（深底浅字判定单源, 替代按页型猜）。"""
    def chan(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = hex_rgb(h, (255, 255, 255))
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)


def is_dark(h):
    return luminance(h) < COLOR["dark_bg_lum"]
