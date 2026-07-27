# -*- coding: utf-8 -*-
"""
solver_blocks.py —— 复合块求解器（v2.6 自 solver.py 拆出, 凛倾 0717"大文件拆分≤1000行"）

职责: table / stat / diagram 三类复合块的几何求解（度量/换行/字号降级/溢出信号）。
  单源原则不变: 换行与坐标只在 solver 层算, 渲染器只消费。
  度量函数经 `import solver` 运行时取用（live globals——set_font/set_canvas 切换后不串快照）。
功能链: solver._make_box → 本模块 *_box() → layout box → ascii/png/pptx 渲染
"""

import solver  # 运行时属性访问（_text_w_in/line_height_in/_wrap_tokens 等 live 绑定）

# ---- v1.5 kind=table（业界参照: python-pptx 原生 add_table + 表头强调/斑马纹惯例）----
TABLE_SIZES = [14, 12, 10]      # 表格字号降级链
TABLE_CELL_PAD_W = 0.14         # 单元格水平内边距合计（英寸）
TABLE_CELL_PAD_H = 0.10         # 单元格垂直内边距合计（英寸）
TABLE_MIN_COL_W = 0.5           # 列最小实测宽下限（英寸，防空列塌缩）
TABLE_MAX_CELL_LINES = 3        # 单元格最多换行行数（超出截断加 …）

STAT_SIZES = [72, 60, 48, 36]  # v1.4 hero级对比(业界"72pt vs 11pt"极端对比, 分身K挖掘)
STAT_LABEL_PT = 14


def _disp_w(s):
    """终端显示列宽（宽/全角=2）——仅用于 solver 拼表格字符画预览行。"""
    import unicodedata
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in s)


def _clip_pad_disp(s, width):
    """按显示宽度裁剪到 <=width（截断加…）并右补空格到恰好 width。"""
    if _disp_w(s) > width:
        out, w = "", 0
        budget = max(0, width - 2)  # … 占 2 列
        for c in s:
            cw = _disp_w(c)
            if w + cw > budget:
                break
            out += c
            w += cw
        s = out + ("…" if width >= 2 else "")
    return s + " " * max(0, width - _disp_w(s))


def _norm_table(block):
    """
    headers/rows 规整化：全部转 str，短行右补空串对齐列数。
    v2.6: 单元格里的 **词** 剥标记并汇入块级强调词表（此前表格是 ** 覆盖盲区,
    字面星号直接渲染进 pptx/png——0717 实拍截图确诊）。
    返回 (headers, rows, ncols, accents)。
    """
    accents = []

    def _clean(s):
        t, words = solver._extract_emphasis(str(s))
        accents.extend(words)
        return t

    headers = [_clean(h) for h in (block.get("headers") or [])]
    rows = [[_clean(c) for c in r] for r in (block.get("rows") or []) if isinstance(r, (list, tuple))]
    ncols = max([len(headers)] + [len(r) for r in rows] + [1])
    headers += [""] * (ncols - len(headers))
    rows = [r + [""] * (ncols - len(r)) for r in rows]
    return headers, rows, ncols, accents


def _measure_table(headers, rows, ncols, pt, box_w_in):
    """
    单字号下的表格几何：列宽按"列内最宽单元格实测宽+内边距"比例分配盒宽，
    单元格在列宽内换行（每格最多 TABLE_MAX_CELL_LINES 行，超出截断加 …）。
    返回 (col_w, header_lines, cell_lines, row_h, total_h)。
    row_h[0]=表头行；cell_lines[i][j]=第 i 数据行第 j 列的最终行数组。
    """
    avail = box_w_in * solver.SAFE_W_RATIO
    need = []
    for j in range(ncols):
        col_cells = [headers[j]] + [r[j] for r in rows]
        w = max(solver._text_w_in(c, pt) for c in col_cells) + TABLE_CELL_PAD_W
        need.append(max(w, TABLE_MIN_COL_W))
    total = sum(need) or 1.0
    col_w = [w * avail / total for w in need]  # 恒铺满可用宽（比例分配）

    def _cell(text, cw):
        lines = solver._wrap_tokens(text, pt, max(0.05, cw - TABLE_CELL_PAD_W))
        if len(lines) > TABLE_MAX_CELL_LINES:
            lines = lines[:TABLE_MAX_CELL_LINES]
            lines[-1] += "…"
        return lines

    header_lines = [_cell(headers[j], col_w[j]) for j in range(ncols)]
    cell_lines = [[_cell(r[j], col_w[j]) for j in range(ncols)] for r in rows]
    lh = solver.line_height_in(pt)
    row_h = [max(len(c) for c in header_lines) * lh + TABLE_CELL_PAD_H]
    for cl in cell_lines:
        row_h.append(max(len(c) for c in cl) * lh + TABLE_CELL_PAD_H)
    return col_w, header_lines, cell_lines, row_h, sum(row_h)


def _table_ascii_lines(headers, rows, ncols, col_w, box_w_in):
    """拼字符画预览行（表头 + ─┼─ 分隔 + 数据行），列宽按英寸比例映射显示列。"""
    inner = max(3 * ncols, round(box_w_in / solver.SLIDE_W_IN * 100) - 2 - (ncols - 1))
    total = sum(col_w) or 1.0
    disp = [max(3, round(cw / total * inner)) for cw in col_w]
    out = ["│".join(_clip_pad_disp(headers[j], disp[j]) for j in range(ncols))]
    out.append("┼".join("─" * disp[j] for j in range(ncols)))
    for r in rows:
        out.append("│".join(_clip_pad_disp(r[j], disp[j]) for j in range(ncols)))
    return out


def _table_needed_h(block, box_w_in, pt=None):
    """表格在给定宽度下的内容高（列排/底带预测量用）。pt 缺省取最大字号。"""
    headers, rows, ncols, _acc = _norm_table(block)
    _cw, _hl, _cl, _rh, total_h = _measure_table(headers, rows, ncols,
                                                 pt or TABLE_SIZES[0], box_w_in)
    return total_h


def _table_box(block, x, y, w, h):
    """v1.5: 表格块。字号降级 14→12→10 适配高度；仍放不下 → overflow + split_table 信号。"""
    headers, rows, ncols, accents = _norm_table(block)
    pt = TABLE_SIZES[-1]
    col_w = header_lines = cell_lines = row_h = None
    total_h = 0.0
    overflow = True
    for cand in TABLE_SIZES:
        col_w, header_lines, cell_lines, row_h, total_h = _measure_table(
            headers, rows, ncols, cand, w)
        if total_h <= h * 0.98:
            pt = cand
            overflow = False
            break
    if overflow:  # 最小字号的几何（循环末次即 10pt）
        pt = TABLE_SIZES[-1]
    cap, cap_acc = solver._extract_emphasis(str(block.get("caption", "")))
    box = {
        "id": block.get("id"),
        "kind": "table",
        "x": round(x, 3), "y": round(y, 3),
        "w": round(w, 3), "h": round(h, 3),
        "font_pt": pt,
        "col_w_in": [round(c, 3) for c in col_w],
        "row_h_in": [round(r, 3) for r in row_h],
        "headers": headers,
        "rows": rows,
        "cell_lines": cell_lines,
        "header_lines": header_lines,
        "caption": cap,
        "accents": accents,  # v2.6 单元格 **词** → 渲染端加粗+accent色
        "lines": _table_ascii_lines(headers, rows, ncols, col_w, w),
        "overflow": overflow,
    }
    sig = None
    if overflow:
        sig = {"block_id": block.get("id"), "type": "overflow",
               "needed_h": round(total_h, 3), "avail_h": round(h, 3),
               "suggestion": "split_table"}
    return box, sig


# ---- v0.5 kind=stat 大数字 callout ----

def _stat_height_in(pt, label_lines=1):
    """stat 总高 = value 行高 + label 行数×行高。"""
    return solver.line_height_in(pt) + solver.line_height_in(STAT_LABEL_PT) * max(1, label_lines)


def _stat_label_lines(block, w):
    """label 按 STAT_LABEL_PT 实测断行（v1.6: label 曾是全管线唯一无量测文本——
    长 label 原样塞单行, png 居中公式出负偏移切头+溢出右栏叠字, 且几何校验只查 box 零信号）。
    v2.6: 先剥 **标记（量测与渲染同源都吃纯文本）。"""
    label, _w = solver._extract_emphasis(str(block.get("label", "")))
    return solver.wrap_text(label, STAT_LABEL_PT, w) if label else [""]


def _stat_box(block, x, y, w, h):
    """
    v0.5: 大数字 callout。v0.7修: 宽+高双约束降字号——原版只看宽且 overflow 恒 False,
    LLM 把 stat 塞进 1.2" bottom 薄带时 60pt 直接截断出画且零信号(e2e实拍盲区)。
    v1.6修: label 进量测——断行入 label_lines(渲染契约新字段, lines=[value,label] 原契约不动),
    fit 循环高度按真实 label 行数算; 仍放不下→overflow 信号带 shorten_label 建议。
    v2.6: value/label 剥 **标记（value 本就加粗 accent 色, 星号属残留符号）。
    返回 (box, signal_or_None)。
    """
    value, _vw = solver._extract_emphasis(str(block.get("value", "")))
    label, _lw = solver._extract_emphasis(str(block.get("label", "")))
    label_lines = _stat_label_lines(block, w)
    pt = STAT_SIZES[-1]
    fits = False
    for cand in STAT_SIZES:
        if (solver._text_w_in(value, cand) <= w * solver.SAFE_W_RATIO
                and _stat_height_in(cand, len(label_lines)) <= h * 0.95):
            pt = cand
            fits = True
            break
    overflow = not fits
    box = {
        "id": block.get("id"),
        "kind": "stat",
        "x": round(x, 3), "y": round(y, 3),
        "w": round(w, 3), "h": round(h, 3),
        "font_pt": pt,
        "label_pt": STAT_LABEL_PT,
        "lines": [value, label],
        "label_lines": label_lines,
        "overflow": overflow,
    }
    sig = None
    if overflow:
        sig = {"block_id": block.get("id"), "type": "overflow",
               "needed_h": round(_stat_height_in(pt, len(label_lines)), 3), "avail_h": round(h, 3),
               "suggestion": "widen_region_or_shorten_label"}
    return box, sig


# ---- v2.7/v3 页型: hero 强设计封面 / quote 大字引言（文字全语义块=可编辑, 装饰走 deco）----
HERO_TITLE_SIZES = [54, 44, 36]
QUOTE_SIZES = [32, 28, 24]


def _fit_lines(txt, sizes, avail_w, max_lines=3):
    """按降级链选字号: 行数≤max_lines 的首个字号; 全超则最小字号。返回 (pt, lines)。"""
    pt, lines = sizes[-1], [txt]
    for cand in sizes:
        lines = solver.wrap_text(txt, cand, avail_w) if txt else [""]
        pt = cand
        if len(lines) <= max_lines:
            break
    return pt, lines


def _text_box(bid, kind, x, y, w, pt, lines, accents=None, align=None):
    box = {"id": bid, "kind": kind, "x": round(x, 3), "y": round(y, 3),
           "w": round(w, 3),
           "h": round(len(lines) * solver.line_height_in(pt) + 0.12, 3),
           "font_pt": pt, "lines": lines, "overflow": False}
    if accents:
        box["accents"] = accents
    if align:
        box["align"] = align
    return box


def solve_hero(slide, sid):
    """
    hero 页: kicker(顶部小字)/title(大字)/subtitle/tagline(底部一行), 左对齐或居中。
    文字=语义块（compose 产 text 原语=原生可编辑）; 深底装饰由 compose 按 deco/theme 补默认。
    """
    mx = 1.0  # hero 边距（tokens.SPACING.hero_margin_x, solver 侧不引 tokens 防层次倒挂, 值经 CONTRACT 锚定）
    W = solver.SLIDE_W_IN - 2 * mx
    align = "center" if str(slide.get("align", "")).strip().lower() == "center" else "left"
    kicker, _a1 = solver._extract_emphasis(str(slide.get("kicker", "")))
    title, t_acc = solver._extract_emphasis(str(slide.get("title", "")))
    sub, s_acc = solver._extract_emphasis(str(slide.get("subtitle", "")))
    tagline, _a2 = solver._extract_emphasis(str(slide.get("tagline", "")))

    t_pt, t_lines = _fit_lines(title, HERO_TITLE_SIZES, W, max_lines=3)
    boxes = []
    # 纵向: 标题块居中于 42% 高度带, kicker 在其上, subtitle 其下, tagline 贴底
    t_h = len(t_lines) * solver.line_height_in(t_pt)
    ty = solver.SLIDE_H_IN * 0.42 - t_h / 2
    if kicker:
        boxes.append(_text_box("%s_kicker" % sid, "hero_kicker", mx, ty - 0.55, W, 14,
                               solver.wrap_text(kicker, 14, W)[:1], align=align))
    boxes.append(_text_box("%s_title" % sid, "hero_title", mx, ty, W, t_pt, t_lines,
                           accents=t_acc, align=align))
    if sub:
        s_lines = solver.wrap_text(sub, 20, W)[:2]
        boxes.append(_text_box("%s_sub" % sid, "hero_sub", mx, ty + t_h + 0.25, W, 20,
                               s_lines, accents=s_acc, align=align))
    if tagline:
        boxes.append(_text_box("%s_tag" % sid, "hero_tag", mx,
                               solver.SLIDE_H_IN - 0.9, W, 12,
                               solver.wrap_text(tagline, 12, W)[:1], align=align))
    return {"id": sid, "type": "hero", "boxes": boxes, "signals": []}


def solve_quote(slide, sid):
    """quote 页: 大字引言居中 + 署名。"""
    mx = 1.6
    W = solver.SLIDE_W_IN - 2 * mx
    txt, q_acc = solver._extract_emphasis(str(slide.get("text", "") or slide.get("title", "")))
    attr, _a = solver._extract_emphasis(str(slide.get("attribution", "")))
    q_pt, q_lines = _fit_lines(txt, QUOTE_SIZES, W, max_lines=5)
    q_h = len(q_lines) * solver.line_height_in(q_pt)
    qy = solver.SLIDE_H_IN * 0.44 - q_h / 2
    boxes = [_text_box("%s_text" % sid, "quote_text", mx, qy, W, q_pt, q_lines,
                       accents=q_acc, align="center")]
    if attr:
        boxes.append(_text_box("%s_attr" % sid, "quote_attr", mx, qy + q_h + 0.3, W, 16,
                               ["—— " + attr], align="center"))
    return {"id": sid, "type": "quote", "boxes": boxes, "signals": []}


def clamp_deco(sl_spec, s_lay):
    """
    deco 几何落定: ①锚定解析（v3.2, 凛倾"文字增多就把文字后面的装饰+几个参数"——
    anchor="块id" 时坐标相对该语义块盒, 文字增多块变高装饰自动跟随; dx/dy 偏移,
    w/h 可填 "match" 取块尺寸）②钳制到画布内。返回落定后的绝对坐标列表。
    """
    W, H = solver.SLIDE_W_IN, solver.SLIDE_H_IN
    boxes = {b.get("id"): b for b in (s_lay.get("boxes") or []) if b.get("id")}
    out = []
    for d in (sl_spec.get("deco") or []):
        nd = dict(d)
        a = nd.pop("anchor", None)
        box = boxes.get(str(a)) if a else None
        if box:
            dx = float(nd.pop("dx", 0) or 0)
            dy = float(nd.pop("dy", 0) or 0)
            for xk, yk in (("x", "y"), ("x1", "y1"), ("x2", "y2")):
                if xk in nd:
                    nd[xk] = box["x"] + dx + nd[xk]
                    nd[yk] = box["y"] + dy + nd.get(yk, 0)
            if not any(k in nd for k in ("x", "x1")):  # 未给坐标=贴块原点
                nd["x"], nd["y"] = box["x"] + dx, box["y"] + dy
            if nd.get("w") == "match":
                nd["w"] = box["w"]
            if nd.get("h") == "match":
                nd["h"] = box["h"]
        else:
            nd.pop("dx", None)
            nd.pop("dy", None)
            for k in ("w", "h"):
                if nd.get(k) == "match":  # 无锚可依, 退默认
                    nd.pop(k)
        # 装饰允许出血（贴边设计常故意越界）, 只钳到 1 个画布尺度内防远飞
        for k, lim in (("x", W), ("y", H), ("x1", W), ("y1", H), ("x2", W), ("y2", H)):
            if k in nd and isinstance(nd[k], (int, float)):
                nd[k] = max(-lim, min(lim * 2, nd[k]))
        for k, lim in (("w", W), ("h", H), ("r", max(W, H))):
            if k in nd and isinstance(nd[k], (int, float)):
                nd[k] = max(0.0, min(lim * 1.5, nd[k]))
        if "alpha" in nd:
            nd["alpha"] = max(0.0, min(1.0, nd["alpha"]))
        out.append(nd)
    return out


# ---- v3 阶段2 kind=widget 小配件组件（单独定义/组装, 全原生形状+文字）----
WIDGET_BADGE_PT = 12
WIDGET_LABEL_PT = 12
RATING_MAX = 5


def _widget_box(block, x, y, w, h):
    """
    widget 几何: badge(胶囊+文字)/progress(进度条+标签+百分比)/rating(五点评分+标签)。
    value 语义归一: progress 值>1 按百分数除 100, 钳 [0,1]; rating 钳 [0,RATING_MAX]。
    文本实测宽（badge 胶囊随字长）。渲染构造在 compose._widget_box（本处只算几何与值域）。
    """
    wtype = block.get("widget")
    text, _a = solver._extract_emphasis(str(block.get("text", "")))
    label, _a2 = solver._extract_emphasis(str(block.get("label", "")))
    val = block.get("value")
    if wtype == "progress":
        v = 0.0 if val is None else float(val)
        v = v / 100.0 if v > 1.0 else v
        val = max(0.0, min(1.0, v))
    elif wtype == "rating":
        v = 0.0 if val is None else float(val)
        val = max(0.0, min(float(RATING_MAX), v))
    box = {
        "id": block.get("id"), "kind": "widget", "widget": wtype,
        "x": round(x, 3), "y": round(y, 3), "w": round(w, 3), "h": round(h, 3),
        "font_pt": WIDGET_BADGE_PT, "label_pt": WIDGET_LABEL_PT,
        "text": text, "label": label, "value": val,
        "text_w_in": round(solver._text_w_in(text, WIDGET_BADGE_PT), 3),
        "lines": ["[配件: %s %s]" % (wtype, text or label or "")],
        "overflow": False,
    }
    return box, None


# ---- v2.6 kind=diagram 原生可编辑流程图 ----
# why: svg 自绘/AI 整页代码在 pptx 侧都是位图, 文字被烙进图不可编辑（凛倾 0717
# "组装起来的不是图片, 需要可以编辑"）。diagram 走语义节点+边 → solver 算几何 →
# pptx 原生形状/连接线（用户可改字挪框）, png/ascii 同源预览。
DIAGRAM_SIZES = [14, 12, 10]   # 节点主标签字号降级链
DIAGRAM_SUB_PT = 10            # 节点副标签字号
DIAGRAM_GAP = 0.45             # 节点间距（箭头区, 英寸）
DIAGRAM_NODE_PAD = 0.24        # 节点内垂直 padding 合计
DIAGRAM_MAX_LABEL_LINES = 3
DIAGRAM_MAX_SUB_LINES = 2


def _diagram_box(block, x, y, w, h):
    """
    确定性布局: direction=lr 节点横排等宽（tb 纵排等高）, 边默认按节点顺序成链,
    显式 edges 覆盖。节点主标签在节点宽内实测断行（字号降级 14→12→10）,
    副标签 10pt。节点高按最高节点统一, 整排在盒内居中。
    放不下（节点太窄/太高）→ overflow + 信号建议减节点或换方向。
    返回 (box, signal_or_None)。
    """
    nodes_in = block.get("nodes") or []
    n = len(nodes_in)
    direction = block.get("direction", "lr")
    tb = (direction == "tb")
    sig = None

    span = (h if tb else w)
    cell = (span - DIAGRAM_GAP * (n - 1)) / max(1, n)
    min_cell = 0.7 if tb else 1.0
    overflow = cell < min_cell
    cell = max(0.45, cell)
    node_w = (w * 0.96) if tb else cell
    inner_w = max(0.3, node_w - 0.16)

    # 字号降级: 所有节点主标签断行 + 统一节点高
    pt = DIAGRAM_SIZES[-1]
    nodes_meta = []
    node_h = 0.0
    for cand in DIAGRAM_SIZES:
        nodes_meta = []
        max_h = 0.0
        for nd in nodes_in:
            label, _aw = solver._extract_emphasis(str(nd.get("label", "")))
            sub, _sw = solver._extract_emphasis(str(nd.get("sub", "")))
            l_lines = solver._wrap_tokens(label, cand, inner_w * solver.SAFE_W_RATIO)
            if len(l_lines) > DIAGRAM_MAX_LABEL_LINES:
                l_lines = l_lines[:DIAGRAM_MAX_LABEL_LINES]
                l_lines[-1] += "…"
            s_lines = []
            if sub:
                s_lines = solver._wrap_tokens(sub, DIAGRAM_SUB_PT, inner_w * solver.SAFE_W_RATIO)
                if len(s_lines) > DIAGRAM_MAX_SUB_LINES:
                    s_lines = s_lines[:DIAGRAM_MAX_SUB_LINES]
                    s_lines[-1] += "…"
            nh = (len(l_lines) * solver.line_height_in(cand)
                  + len(s_lines) * solver.line_height_in(DIAGRAM_SUB_PT)
                  + DIAGRAM_NODE_PAD)
            max_h = max(max_h, nh)
            nodes_meta.append({"id": nd.get("id"), "lines": l_lines, "sub_lines": s_lines})
        pt, node_h = cand, max_h
        limit = cell if tb else h * 0.92
        if max_h <= limit:
            break
    else:
        overflow = True

    # 摆位: lr 横排垂直居中 / tb 纵排水平居中
    out_nodes = []
    if tb:
        nx = x + (w - node_w) / 2
        ny = y + max(0.0, (h - (cell * n + 0.0)) / 2)
        for i, m in enumerate(nodes_meta):
            out_nodes.append({**m, "x": round(nx, 3), "y": round(ny + i * (cell + 0.0), 3),
                              "w": round(node_w, 3), "h": round(min(node_h, cell), 3)})
        # tb 的 cell 已含 gap 计算（span 均分）, 节点间自然留 gap
        for i, nd in enumerate(out_nodes):
            nd["y"] = round(y + max(0.0, (h - (n * node_h + (n - 1) * DIAGRAM_GAP)) / 2)
                            + i * (node_h + DIAGRAM_GAP), 3)
            nd["h"] = round(node_h, 3)
    else:
        ny = y + max(0.0, (h - node_h) / 2)
        for i, m in enumerate(nodes_meta):
            out_nodes.append({**m, "x": round(x + i * (cell + DIAGRAM_GAP), 3),
                              "y": round(ny, 3),
                              "w": round(cell, 3), "h": round(node_h, 3)})

    # 边: 显式 edges, 无则按顺序成链
    id2nd = {nd["id"]: nd for nd in out_nodes if nd.get("id")}
    edges_in = block.get("edges") or []
    if not edges_in and n >= 2:
        ids = [nd["id"] for nd in out_nodes]
        edges_in = [[ids[i], ids[i + 1], ""] for i in range(n - 1)]
    out_edges = []
    for e in edges_in:
        a, c = id2nd.get(e[0]), id2nd.get(e[1])
        if not a or not c:
            continue
        lbl = e[2] if len(e) > 2 else ""
        if tb and c["y"] > a["y"]:
            x1, y1 = a["x"] + a["w"] / 2, a["y"] + a["h"]
            x2, y2 = c["x"] + c["w"] / 2, c["y"]
        elif (not tb) and c["x"] > a["x"]:
            x1, y1 = a["x"] + a["w"], a["y"] + a["h"] / 2
            x2, y2 = c["x"], c["y"] + c["h"] / 2
        else:  # 回指/同位: 中心连中心（少见, 诚实画直线）
            x1, y1 = a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
            x2, y2 = c["x"] + c["w"] / 2, c["y"] + c["h"] / 2
        out_edges.append({"x1": round(x1, 3), "y1": round(y1, 3),
                          "x2": round(x2, 3), "y2": round(y2, 3), "label": lbl})

    # ascii 预览行: 流程摘要
    labels = [" ".join(m["lines"]) for m in nodes_meta]
    arrow = " ↓ " if tb else " → "
    summary = arrow.join(labels[:5]) + (" …" if n > 5 else "")
    box = {
        "id": block.get("id"),
        "kind": "diagram",
        "x": round(x, 3), "y": round(y, 3),
        "w": round(w, 3), "h": round(h, 3),
        "font_pt": pt,
        "sub_pt": DIAGRAM_SUB_PT,
        "direction": "tb" if tb else "lr",
        "nodes": out_nodes,
        "edges": out_edges,
        "lines": ["[图解: %s]" % summary],
        "overflow": overflow,
    }
    if overflow:
        sig = {"block_id": block.get("id"), "type": "overflow",
               "needed_h": round(node_h, 3), "avail_h": round(h, 3),
               "suggestion": "reduce_nodes_or_direction_%s" % ("lr" if tb else "tb")}
    return box, sig
