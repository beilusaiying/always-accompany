# -*- coding: utf-8 -*-
"""
ascii_view.py —— layout(dict) → 框线字符画字符串（终端预览）

功能链（本模块在管线中的位置）:
    solver.py 产出 layout.json（含每个 box 的英寸坐标 x/y/w/h + 已算好的 lines）
    → 本模块 render_ascii() 只做"英寸坐标 → 100×30 字符网格"的映射 + 画框，
      禁止重新换行/重新测量（单源原则：换行只在 solver 做）。

契约要点（见 CONTRACT.md 92-96 行）:
    - 网格 100 列 × 30 行
    - col = round(x/13.333*100)，row = round(y/7.5*30)
    - box 画 ┌─┐│└┘ 框，框内嵌 lines（超宽截断加 …）
    - title(kind=="title") 用 `██ ` 前缀不画框
    - overflow 的框右上角标 `!`
    - 全部页拼接，页间空行 + 页码行

本模块最大的坑（why 要处理显示宽度）:
    中文字符在终端占 2 列宽。网格里"1 格 = 1 显示列"，若按 len() 计数放字符，
    含中文的行会把右框线顶歪。故所有横向定位/裁剪都按"显示宽度"算：
    east_asian_width 为 W(宽) 或 F(全角) 记 2 列，其余记 1 列。
"""

import unicodedata

# —— 画布/网格常量（与 CONTRACT.md 一致）——
SLIDE_W_IN = 13.333
SLIDE_H_IN = 7.5
GRID_COLS = 100
GRID_ROWS = 30


def _set_grid(layout):
    """v2.2 画布参数化: 网格随 layout 尺寸派生（1列≈0.13333in, 1行≈0.25in 密度不变）。"""
    global SLIDE_W_IN, SLIDE_H_IN, GRID_COLS, GRID_ROWS
    SLIDE_W_IN = float(layout.get("slide_w_in") or 13.333)
    SLIDE_H_IN = float(layout.get("slide_h_in") or 7.5)
    GRID_COLS = max(40, round(SLIDE_W_IN / 0.13333))
    GRID_ROWS = max(15, round(SLIDE_H_IN / 0.25))

# 框线字符
TL, TR, BL, BR = "┌", "┐", "└", "┘"
HB, VB = "─", "│"

# 网格单元的三种态：
#   None  = 空单元（渲染成 1 个空格）
#   _SKIP = 宽字符占位次格（渲染时跳过，不输出字符）
#   其它  = 实际字符
_SKIP = object()


def _char_width(ch: str) -> int:
    """单个字符的终端显示列宽：宽/全角=2，其余=1。"""
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    return 1


def _disp_width(s: str) -> int:
    """字符串的终端显示总列宽。"""
    return sum(_char_width(c) for c in s)


def _truncate_to_width(s: str, max_w: int, ellipsis: str = "…") -> str:
    """
    把 s 截断到显示宽度 <= max_w。若发生截断，末尾放省略号 …（… 本身占 2 列）。
    逐字符累加显示宽度，避免在一个宽字符"中间"切断导致对齐错乱。
    """
    if _disp_width(s) <= max_w:
        return s
    if max_w <= 0:
        return ""
    ell_w = _char_width(ellipsis)  # … 是全角，占 2 列
    if max_w < ell_w:
        # 连省略号都放不下，只能硬截到 max_w 列（用空格补足由调用方处理）
        out, w = "", 0
        for c in s:
            cw = _char_width(c)
            if w + cw > max_w:
                break
            out += c
            w += cw
        return out
    budget = max_w - ell_w
    out, w = "", 0
    for c in s:
        cw = _char_width(c)
        if w + cw > budget:
            break
        out += c
        w += cw
    return out + ellipsis


def _put(grid, r, c, s):
    """
    在网格 (r, c) 起始按显示宽度铺字符串 s。
    宽字符占 2 格：首格放该字符，次格放哨兵 _SKIP（占位）；
    渲染成行时哨兵被跳过（不输出任何字符）—— 因为一个宽字符本身
    在终端就占 2 显示列，占了 2 个网格逻辑格却只输出 1 个字符，
    这样"网格逻辑宽度 == 终端显示宽度"，框线才不会歪。

    注意 why：不能把占位次格渲染成空格，否则宽字符后凭空多一个空格，
    行的显示宽度膨胀、右框线被顶出去（这是本模块踩过的坑）。
    """
    if r < 0 or r >= len(grid):
        return
    col = c
    for ch in s:
        if col < 0:
            col += 1
            continue
        if col >= GRID_COLS:
            break
        grid[r][col] = ch
        cw = _char_width(ch)
        if cw == 2 and col + 1 < GRID_COLS:
            grid[r][col + 1] = _SKIP   # 宽字符第二格：哨兵占位，渲染时跳过
        col += cw


def _x_to_col(x_in: float) -> int:
    return round(x_in / SLIDE_W_IN * GRID_COLS)


def _y_to_row(y_in: float) -> int:
    return round(y_in / SLIDE_H_IN * GRID_ROWS)


def _render_box(grid, box):
    """
    把一个非 title 的 box 画到网格：外框 ┌─┐│└┘ + 框内嵌 lines。
    横向按显示列裁剪、纵向超行截断，overflow 的框右上角标 `!`。
    """
    c0 = _x_to_col(box["x"])
    r0 = _y_to_row(box["y"])
    c1 = _x_to_col(box["x"] + box["w"])
    r1 = _y_to_row(box["y"] + box["h"])

    # 夹到网格内并保证最小尺寸（至少能画出上下框线）
    c0 = max(0, min(c0, GRID_COLS - 1))
    r0 = max(0, min(r0, GRID_ROWS - 1))
    c1 = max(c0 + 2, min(c1, GRID_COLS - 1))
    r1 = max(r0 + 2, min(r1, GRID_ROWS - 1))

    inner_w = c1 - c0 - 1          # 框内可用显示列数（去掉左右两条竖线）
    overflow = box.get("overflow", False)

    # —— 顶边 ——
    _put(grid, r0, c0, TL)
    for c in range(c0 + 1, c1):
        _put(grid, r0, c, HB)
    _put(grid, r0, c1, TR)
    if overflow:
        # 右上角标 !：放 TR 左侧一格的顶边上，保留 ┐ 角、不破坏框形
        _put(grid, r0, c1 - 1, "!")

    # —— 底边 ——
    _put(grid, r1, c0, BL)
    for c in range(c0 + 1, c1):
        _put(grid, r1, c, HB)
    _put(grid, r1, c1, BR)

    # —— 左右竖线 ——
    for r in range(r0 + 1, r1):
        _put(grid, r, c0, VB)
        _put(grid, r, c1, VB)

    # —— 框内文本 ——
    lines = box.get("lines", [])
    max_text_rows = r1 - r0 - 1   # 框内可用行数
    for i in range(max_text_rows):
        rr = r0 + 1 + i
        if i >= len(lines):
            break
        text = lines[i]
        # 若行数超过可用行且是最后一个可显示行，标注剩余省略
        if i == max_text_rows - 1 and len(lines) > max_text_rows:
            text = _truncate_to_width(text, inner_w - 2) + " …"
            text = _truncate_to_width(text, inner_w)
        else:
            text = _truncate_to_width(text, inner_w)
        _put(grid, rr, c0 + 1, text)


def _render_title(grid, box):
    """title 不画框，用 `██ ` 前缀直接铺在标题行上。"""
    c0 = _x_to_col(box["x"])
    r0 = _y_to_row(box["y"])
    c0 = max(0, min(c0, GRID_COLS - 1))
    r0 = max(0, min(r0, GRID_ROWS - 1))
    lines = box.get("lines", [])
    text = lines[0] if lines else ""
    prefix = "██ "
    avail = GRID_COLS - c0 - _disp_width(prefix)
    text = _truncate_to_width(text, max(0, avail))
    _put(grid, r0, c0, prefix + text)


def _render_slide(slide) -> str:
    """渲染单页为字符画字符串（不含页码行）。"""
    grid = [[None for _ in range(GRID_COLS)] for _ in range(GRID_ROWS)]
    # 先画非 title 的框，再画 title（title 覆盖优先，避免被框线压住）
    for box in slide.get("boxes", []):
        if box.get("kind") != "title":
            _render_box(grid, box)
    for box in slide.get("boxes", []):
        if box.get("kind") == "title":
            _render_title(grid, box)

    out_rows = []
    for row in grid:
        buf = []
        for cell in row:
            if cell is _SKIP:
                continue          # 宽字符占位次格：不输出
            buf.append(cell if cell is not None else " ")  # 空单元 → 空格
        out_rows.append("".join(buf).rstrip())
    return "\n".join(out_rows)


def render_ascii(layout: dict) -> str:
    """
    layout(dict) → 全部页拼接的字符画字符串。
    页间用空行分隔，每页后跟一行页码 `── 第 i/N 页 : <id> ──`。
    """
    _set_grid(layout)  # v2.2: 网格随画布
    slides = layout.get("slides", [])
    n = len(slides)
    parts = []
    meta_title = layout.get("meta_title", "")
    if meta_title:
        parts.append(f"╔══ {meta_title} ══╗")
        parts.append("")
    for i, slide in enumerate(slides, start=1):
        parts.append(_render_slide(slide))
        parts.append(f"── 第 {i}/{n} 页 : {slide.get('id', '')} ──")
        if i < n:
            parts.append("")  # 页间空行
    return "\n".join(parts)


# ──────────────────────────────────────────────────────────────
# 自测：内置最小 layout 样例（按 CONTRACT.md layout.json 结构手写）
# ──────────────────────────────────────────────────────────────
def _demo_layout() -> dict:
    return {
        "slide_w_in": SLIDE_W_IN,
        "slide_h_in": SLIDE_H_IN,
        "font": "微软雅黑",
        "meta_title": "ASCII 渲染器自测样例",
        "slides": [
            {
                "id": "s1",
                "boxes": [
                    {"id": "s1_title", "kind": "title",
                     "x": 0.6, "y": 0.35, "w": 12.13, "h": 1.0,
                     "font_pt": 32, "lines": ["第一页：中文标题对齐测试"],
                     "overflow": False},
                    {"id": "b1", "kind": "bullets",
                     "x": 0.6, "y": 1.55, "w": 7.8, "h": 4.4,
                     "font_pt": 18,
                     "lines": ["• 要点一：验证框线对齐",
                               "• 要点二：中文占两列宽",
                               "  续行缩进两个空格",
                               "• 要点三：这是一条特别长的中英文混排 line 用来测试超宽截断 abcdefghij"],
                     "overflow": False},
                    {"id": "b2", "kind": "image",
                     "x": 8.7, "y": 1.55, "w": 4.0, "h": 4.4,
                     "font_pt": 14, "lines": ["[图: 系统架构图]"],
                     "overflow": False},
                    {"id": "b3", "kind": "text",
                     "x": 0.6, "y": 6.2, "w": 12.13, "h": 1.0,
                     "font_pt": 16,
                     "lines": ["底部说明：这一框标记了 overflow，右上角应有感叹号 !",
                               "第二行溢出内容一二三四五六七八九十"],
                     "overflow": True},
                ],
                "signals": [
                    {"block_id": "b3", "type": "overflow",
                     "needed_h": 1.6, "avail_h": 1.0, "suggestion": "reduce_items"}
                ],
            }
        ],
    }


if __name__ == "__main__":
    art = render_ascii(_demo_layout())
    print(art)
    # 自检辅助：打印每行显示宽度，方便肉眼确认框线列对齐
    print("\n[自检] 各行显示宽度（框线所在行应一致）:")
    for idx, ln in enumerate(art.split("\n")):
        w = _disp_width(ln)
        if "┌" in ln or "└" in ln or "│" in ln:
            print(f"  row{idx:02d} width={w:3d}  {ln}")
