# -*- coding: utf-8 -*-
"""
compose.py —— v3 场景构造器：layout+theme+tokens → 场景图（视觉决策唯一产地）

凛倾 0717 定案（v3框架设计 §四）: 原 png_view/pptx_out 双端各写一遍的全部视觉特性
（标题竖条/title_rule/卡片tint/line卡/斑马表格/stat卡/图注/页脚/大页码/divider band|card/
cover 三明治配色/bullet 前缀染色/accents 强调/hero 默认装饰/deco/diagram）在此收编,
**每个特性一个构造函数, 只写一遍**。两端一致从注释约定变为结构保证。

分工: 度量与换行仍是 solver 单源(本模块只消费 lines/坐标; 唯一例外 divider card 的
渲染域重排——契约既有豁免点, 随构造收编到算法层, 画笔保持零测量)。
功能链: pipeline.run → solve → compose(layout) → scene → png_paint/pptx_paint
"""

import scene
import solver
import tokens
from tokens import COLOR, SPACING, TYPE_SCALE


def _theme(layout):
    t = layout.get("theme") or {}
    return {
        "on": bool(layout.get("theme")),
        "bg": t.get("bg_color") or "FFFFFF",
        "title": t.get("title_color"),
        "body": t.get("body_color"),
        "accent": t.get("accent_color"),
        "cover_title": t.get("cover_title_color"),
        "cover_bg": t.get("cover_bg_color"),
        "big_page_number": bool(t.get("big_page_number")),
        "divider_style": t.get("divider_style") or "band",
        "card_style": t.get("card_style", "tint"),
        "title_rule": bool(t.get("title_rule")),
    }


def _accent(th):
    return th["accent"] or COLOR["default_accent"]


def _palette(sl, th, eff_bg_img):
    """
    页级配色决策单源（原双端 cover_rgb/_cover_solid/own_bg 三套判定收编）:
    返回 {title, body, bg_fill, is_light_text}。
    浅字条件: cover/hero/quote 且（页级专属深底图 | cover_bg 纯色深底 | 深色 deco 底）。
    """
    stype = sl.get("type")
    own_bg = sl.get("bg_image") not in (None, "none")
    deco_dark = None
    for d in (sl.get("deco") or []):
        if d.get("type") == "gradient_bg" and d.get("from"):
            deco_dark = tokens.is_dark(d["from"])
            break
        if (d.get("type") == "rect" and d.get("color")
                and d.get("w", 0) >= 0.9 * solver.SLIDE_W_IN
                and d.get("h", 0) >= 0.9 * solver.SLIDE_H_IN):
            deco_dark = tokens.is_dark(d["color"])
            break
    cover_solid = (stype in ("cover", "hero") and not eff_bg_img
                   and th["cover_bg"] is not None and deco_dark is None)
    light = (stype in ("cover", "hero", "quote")
             and th["cover_title"] is not None
             and (own_bg or cover_solid or deco_dark is True))
    return {
        "bg_fill": th["cover_bg"] if cover_solid else (th["bg"] if th["on"] else None),
        "title": th["cover_title"] if light else th["title"],
        "body": th["cover_title"] if light else th["body"],
        "light": light,
    }


# ---------------- 特性构造（每个只写一遍） ----------------

def _bg(slot, sl, th, pal, eff_bg_img, W, H):
    if pal["bg_fill"]:
        scene.add(slot, "background", scene.shape("rect", 0, 0, W, H, fill=pal["bg_fill"]))
    if eff_bg_img:
        scene.add(slot, "background", scene.image(eff_bg_img, 0, 0, W, H))


def _deco(slot, sl, th, W, H):
    acc = _accent(th)
    for d in (sl.get("deco") or []):
        t = d.get("type")
        if t == "gradient_bg":
            scene.add(slot, "background", scene.gradient(
                0, 0, W, H, d.get("from") or "0F172A", d.get("to") or acc,
                angle=d.get("angle", 135)))
        elif t == "circle":
            r = d.get("r", 1.0)
            scene.add(slot, "decoration", scene.shape(
                "oval", d.get("x", 0) - r, d.get("y", 0) - r, r * 2, r * 2,
                fill=d.get("color") or acc, alpha=d.get("alpha")))
        elif t == "rect":
            scene.add(slot, "decoration", scene.shape(
                "rect", d.get("x", 0), d.get("y", 0), d.get("w", 1), d.get("h", 1),
                fill=d.get("color") or acc, alpha=d.get("alpha")))
        elif t == "line":
            scene.add(slot, "decoration", scene.line(
                d.get("x1", 0), d.get("y1", 0), d.get("x2", 1), d.get("y2", 0),
                d.get("color") or acc, width_pt=d.get("width_pt", 1.5)))
        elif t == "art" and d.get("src"):
            # v3.1: 前端小图组件（pipeline._resolve_deco_art 已渲成透明 PNG; 无 src=渲染失败缺省）
            scene.add(slot, "decoration", scene.image(
                d["src"], d.get("x", 0), d.get("y", 0), d.get("w", 2.0), d.get("h", 2.0)))


def _hero_default_deco(sl, th):
    """hero 页无 deco 时按主题派生默认装饰组（深底渐变+右上圆+左下条——原自由页高频形态的组件化）。"""
    if sl.get("deco"):
        return
    acc = _accent(th)
    base = th["cover_bg"] or tokens.mix(acc, "101318", 0.25)
    sl["deco"] = [
        {"type": "gradient_bg", "from": base, "to": tokens.mix(acc, base, 0.30), "angle": 135},
        {"type": "circle", "x": solver.SLIDE_W_IN + 0.6, "y": -0.6, "r": 2.4,
         "color": acc, "alpha": 0.30},
        {"type": "rect", "x": SPACING["hero_margin_x"], "y": solver.SLIDE_H_IN - 1.35,
         "w": 3.2, "h": 0.07, "color": acc},
    ]


def _footer(slot, layout, sl, page_no, W, H, is_special):
    if is_special:
        return
    y = H - SPACING["footer_y_from_bottom"]
    title = layout.get("meta_title", "")
    if title:
        scene.add(slot, "annotation", scene.text(
            SPACING["page_margin_x"], y, SPACING["footer_title_w"], SPACING["footer_h"],
            scene.run_rows([title], TYPE_SCALE["footer"], color=COLOR["gray_footer"])))
    scene.add(slot, "annotation", scene.text(
        W - 1.4, y, SPACING["footer_page_w"], SPACING["footer_h"],
        scene.run_rows([str(page_no)], TYPE_SCALE["footer"], color=COLOR["gray_footer"]),
        align="right"))


def _big_page(slot, th, page_no, W, is_special):
    if not th["big_page_number"] or is_special:
        return
    col = tokens.mix(_accent(th), "FFFFFF", COLOR["bigpage_sat"])
    scene.add(slot, "decoration", scene.text(
        W - SPACING["bigpage_from_right"], SPACING["bigpage_y"],
        SPACING["bigpage_w"], SPACING["bigpage_h"],
        scene.run_rows(["%02d" % page_no], TYPE_SCALE["big_page"], color=col, bold=True),
        wrap=False))


def _overflow_mark(slot, box):
    if box.get("overflow"):
        scene.add(slot, "annotation", dict(scene.text(
            box["x"] + box["w"] - 0.3, box["y"] + 0.02, 0.3, 0.35,
            scene.run_rows(["!"], TYPE_SCALE["overflow_mark"],
                           color=COLOR["overflow_mark"], bold=True), wrap=False),
            preview_only=True))


def _title_box(slot, box, sl, th, pal):
    if not any(l.strip() for l in (box.get("lines") or [])):
        return  # 空标题不产元素（legacy 迁移页/无题页: 竖条悬空=瑕疵）
    is_cover_like = sl.get("type") in ("cover", "hero", "quote")
    acc = _accent(th)
    if th["on"] and not is_cover_like:
        scene.add(slot, "decoration", scene.shape(
            "rect", box["x"] - SPACING["title_bar_dx"], box["y"] + SPACING["title_bar_pad_y"],
            SPACING["title_bar_w"], box["h"] - 2 * SPACING["title_bar_pad_y"], fill=acc))
        if th["title_rule"]:
            scene.add(slot, "decoration", scene.line(
                box["x"], box["y"] + box["h"] - 0.05,
                box["x"] + box["w"], box["y"] + box["h"] - 0.05,
                COLOR["gray_rule"], width_pt=0.5))
    scene.add(slot, "content", scene.text(
        box["x"], box["y"], box["w"], box["h"],
        scene.run_rows(box.get("lines"), box["font_pt"], color=pal["title"], bold=True,
                       accents=box.get("accents"), accent_color=(acc if th["on"] else None)),
        align=box.get("align") or ("center" if sl.get("type") == "cover" else "left"),
        anchor="middle"))


def _body_box(slot, box, sl, th, pal):
    """bullets/text/hero_*/quote_* 文本块 + 卡片装饰。bullet 前缀 accent 染色在 run 层落位。"""
    kind = box["kind"]
    acc = _accent(th)
    is_cover_like = sl.get("type") in ("cover", "hero", "quote")
    if th["on"] and not is_cover_like and kind in ("bullets", "text"):
        if th["card_style"] == "line":
            scene.add(slot, "decoration", scene.shape(
                "rect", box["x"], box["y"], SPACING["card_bar_w"], box["h"], fill=acc))
            scene.add(slot, "decoration", scene.line(
                box["x"], box["y"] + box["h"], box["x"] + box["w"], box["y"] + box["h"],
                COLOR["gray_rule"], width_pt=0.5))
        else:
            scene.add(slot, "decoration", scene.shape(
                "rect", box["x"], box["y"], box["w"], box["h"],
                fill=tokens.mix(acc, th["bg"], COLOR["card_tint_ratio"])))
            scene.add(slot, "decoration", scene.shape(
                "rect", box["x"], box["y"], SPACING["card_bar_w"], box["h"], fill=acc))
    # 逐行 runs: bullet 前缀单独 run 染 accent（原 png 特性, 收编单源后 pptx 同享）
    rows = []
    bp = solver.BULLET_CHAR + " "
    for line in (box.get("lines") or [""]):
        if th["on"] and kind == "bullets" and line.startswith(bp):
            head = [{"t": bp, "pt": box["font_pt"], "color": acc}]
            rest = scene.run_rows([line[len(bp):]], box["font_pt"], color=pal["body"],
                                  accents=box.get("accents"), accent_color=acc)[0]
            rows.append(head + rest)
        else:
            rows.append(scene.run_rows([line], box["font_pt"], color=pal["body"],
                                       accents=box.get("accents"),
                                       accent_color=(acc if th["on"] else None))[0])
    # hero/quote 小部件字色: kicker/tag/attr 用淡化色
    if kind in ("hero_kicker", "hero_tag", "quote_attr"):
        dim = tokens.mix(pal["body"] or "666666", th["bg"] if not pal["light"] else "000000", 0.7)
        for row in rows:
            for r in row:
                r["color"] = dim
    scene.add(slot, "content", scene.text(
        box["x"], box["y"], box["w"], box["h"], rows,
        align=box.get("align") or ("center" if sl.get("type") == "cover" else "left")))


def _stat_box(slot, box, th, pal):
    acc = _accent(th)
    if th["on"]:
        scene.add(slot, "decoration", scene.shape(
            "rect", box["x"], box["y"], box["w"], box["h"],
            fill=tokens.mix(acc, th["bg"], COLOR["stat_tint_ratio"])))
    value = (box.get("lines") or [""])[0]
    rows = scene.run_rows([value], box["font_pt"],
                          color=(acc if th["on"] else pal["title"]), bold=True)
    rows += scene.run_rows(box.get("label_lines") or [""], box.get("label_pt", 14),
                           color=pal["body"])
    scene.add(slot, "content", scene.text(
        box["x"], box["y"], box["w"], box["h"], rows, align="center", anchor="middle"))


def _image_box(slot, box):
    src = box.get("src")
    fit = _fit_dims(src, box) if src else None
    if fit:
        scene.add(slot, "content", scene.image(src, *fit))
        return
    scene.add(slot, "decoration", scene.shape(
        "rect", box["x"], box["y"], box["w"], box["h"], fill=COLOR["gray_fill"]))
    scene.add(slot, "content", scene.text(
        box["x"], box["y"], box["w"], box["h"],
        scene.run_rows(box.get("lines"), box.get("font_pt", 14), color=COLOR["gray_text"]),
        align="center", anchor="middle"))


def _fit_dims(src, box):
    """真图等比缩放居中（fit-inside）。打不开→None 占位框。原双端 _picture_fit_dims 收编。"""
    try:
        from PIL import Image
        with Image.open(src) as im:
            sw, sh = im.size
        if sw <= 0 or sh <= 0:
            return None
        sc = min(box["w"] / sw, box["h"] / sh)
        nw, nh = sw * sc, sh * sc
        return (box["x"] + (box["w"] - nw) / 2, box["y"] + (box["h"] - nh) / 2, nw, nh)
    except Exception:
        return None


def _caption(slot, box):
    cap = box.get("caption")
    if cap:
        scene.add(slot, "content", scene.text(
            box["x"], box["y"] + box["h"] + SPACING["caption_gap"],
            box["w"], SPACING["caption_h"],
            scene.run_rows([cap], TYPE_SCALE["caption"], color=COLOR["gray_text"]),
            align="center"))


def _chart_box(slot, box, th):
    el = {"p": "chart", "x": box["x"], "y": box["y"], "w": box["w"],
          "h": box["h"] - (SPACING["caption_h"] if box.get("caption") else 0),
          "chart_type": box.get("chart_type", "bar"), "title": box.get("title", ""),
          "categories": box.get("categories", []), "series": box.get("series", []),
          "accent": _accent(th) if th["on"] else None}
    scene.add(slot, "content", el)
    _caption(slot, dict(box, h=el["h"]))


def _table_box(slot, box, th, pal):
    acc = _accent(th)
    body = pal["body"] or "333333"
    base = th["bg"] if th["on"] else "FFFFFF"
    band = tokens.mix(acc, base, COLOR["table_band_ratio"])
    accents = box.get("accents") or None
    headers = box.get("headers") or []
    rows_txt = box.get("rows") or []
    hl = box.get("header_lines") or []
    cl = box.get("cell_lines") or []
    pt = box.get("font_pt", 12)

    def cell(full_text, wrapped_lines, fill, col, bold, use_acc):
        return {
            "full": scene.run_rows([full_text], pt, color=col, bold=bold,
                                   accents=(accents if use_acc else None),
                                   accent_color=(acc if use_acc else None))[0],
            "rows": scene.run_rows(wrapped_lines or [""], pt, color=col, bold=bold,
                                   accents=(accents if use_acc else None),
                                   accent_color=(acc if use_acc else None)),
            "fill": fill,
        }

    cells = [[cell(h, hl[j] if j < len(hl) else [h], acc, "FFFFFF", True, False)
              for j, h in enumerate(headers)]]
    for i, r in enumerate(rows_txt):
        fill = band if i % 2 else base
        cells.append([cell(r[j] if j < len(r) else "",
                           cl[i][j] if i < len(cl) and j < len(cl[i]) else [""],
                           fill, body, False, True)
                      for j in range(len(headers))])
    scene.add(slot, "content", {
        "p": "table", "x": box["x"], "y": box["y"], "w": box["w"],
        "col_w_in": box.get("col_w_in", []), "row_h_in": box.get("row_h_in", []),
        "pt": pt, "cells": cells, "margin": SPACING["table_cell_margin"],
        "sep_color": COLOR["gray_fill"]})
    _caption(slot, dict(box, h=sum(box.get("row_h_in") or [box["h"]])))


def _diagram_box(slot, box, th, pal):
    acc = _accent(th)
    body = pal["body"] or "333333"
    for nd in (box.get("nodes") or []):
        scene.add(slot, "content", scene.shape(
            "rect", nd["x"], nd["y"], nd["w"], nd["h"],
            fill=tokens.mix(acc, th["bg"] if th["on"] else "FFFFFF",
                            COLOR["diagram_tint_ratio"]),
            line_color=acc, line_pt=SPACING["diagram_node_line_pt"]))
        rows = scene.run_rows(nd.get("lines") or [""], box.get("font_pt", 14),
                              color=body, bold=True)
        rows += scene.run_rows(nd.get("sub_lines") or [], box.get("sub_pt", 10),
                               color=COLOR["gray_text"])
        scene.add(slot, "content", scene.text(
            nd["x"], nd["y"], nd["w"], nd["h"], rows, align="center", anchor="middle"))
    for e in (box.get("edges") or []):
        scene.add(slot, "content", scene.line(
            e["x1"], e["y1"], e["x2"], e["y2"], acc,
            width_pt=SPACING["diagram_edge_line_pt"], arrow=True))
        if e.get("label"):
            scene.add(slot, "content", scene.text(
                (e["x1"] + e["x2"]) / 2 - 0.5, (e["y1"] + e["y2"]) / 2 - 0.3, 1.0, 0.25,
                scene.run_rows([e["label"]], TYPE_SCALE["edge_label"],
                               color=COLOR["gray_text"]), align="center", wrap=False))


def _divider(slot, sl, th, W, H):
    """divider band|card（原双端 4 份实现收编）。card 重排是渲染域唯一测量豁免, 收进算法层。"""
    acc = _accent(th)
    boxes = sl.get("boxes", [])
    if th["divider_style"] == "card":
        bw = W * SPACING["divider_card_ratio"]
        scene.add(slot, "decoration", scene.shape("rect", 0, 0, bw, H, fill=acc))
        avail = bw - 1.0
        for box in boxes:
            joined = ""
            for r0 in (box.get("lines") or [""]):
                if (joined and joined[-1:].isascii() and joined[-1:].isalnum()
                        and r0[:1].isascii() and r0[:1].isalnum()):
                    joined += " "
                joined += r0
            fpt = box.get("font_pt", 34)
            rows = [joined]
            for cand in [p for p in (fpt, 28, 24, 20) if p <= fpt]:
                rows = solver.wrap_text(joined, cand, avail) if joined else [""]
                fpt = cand
                if len(rows) * solver.line_height_in(cand) <= H - box["y"] - 0.4:
                    break
            scene.add(slot, "content", scene.text(
                0.5, box["y"], bw - 0.7, max(box["h"], len(rows) * solver.line_height_in(fpt)),
                scene.run_rows(rows, fpt, color="FFFFFF"), anchor="middle"))
    else:
        pad = SPACING["divider_band_pad"]
        if boxes:
            top = max(0.0, min(b["y"] for b in boxes) - pad)
            bot = min(H, max(b["y"] + b["h"] for b in boxes) + pad)
            if bot - top < SPACING["divider_band_min_h"]:
                top = max(0.0, (top + bot) / 2 - SPACING["divider_band_min_h"] / 2)
                bot = top + SPACING["divider_band_min_h"]
        else:
            top = (H - SPACING["divider_band_min_h"]) / 2
            bot = top + SPACING["divider_band_min_h"]
        scene.add(slot, "decoration", scene.shape("rect", 0, top, W, bot - top, fill=acc))
        for box in boxes:
            scene.add(slot, "content", scene.text(
                box["x"], box["y"], box["w"], box["h"],
                scene.run_rows(box.get("lines"), box.get("font_pt", 34), color="FFFFFF"),
                align="center", anchor="middle"))


def _widget_box(slot, box, th, pal):
    """
    v3 阶段2 小配件构造（badge/progress/rating）——纯 shape+text 原语组合,
    画笔零改动即获得双端渲染（组件化架构红利的实证点）。全部落 widget 图层。
    """
    acc = _accent(th)
    body = pal["body"] or "333333"
    wtype = box.get("widget")
    x, y, w, h = box["x"], box["y"], box["w"], box["h"]
    if wtype == "badge":
        bw = min(w, box.get("text_w_in", 0.6) + 0.45)
        bh = 0.38
        bx = x + (w - bw) / 2
        by = y + (h - bh) / 2
        scene.add(slot, "widget", scene.shape("oval" if bw <= bh * 1.2 else "rect",
                                              bx, by, bw, bh, fill=acc))
        scene.add(slot, "widget", scene.text(
            bx, by, bw, bh, scene.run_rows([box.get("text") or ""], box.get("font_pt", 12),
                                           color="FFFFFF", bold=True),
            align="center", anchor="middle", wrap=False))
    elif wtype == "progress":
        v = box.get("value") or 0.0
        track_h = 0.22
        ty = y + h / 2 - track_h / 2 + 0.1
        scene.add(slot, "widget", scene.shape(
            "rect", x, ty, w, track_h, fill=tokens.mix(acc, th["bg"], 0.15)))
        if v > 0:
            scene.add(slot, "widget", scene.shape("rect", x, ty, max(0.02, w * v),
                                                  track_h, fill=acc))
        if box.get("label"):
            scene.add(slot, "widget", scene.text(
                x, ty - 0.32, w * 0.7, 0.28,
                scene.run_rows([box["label"]], box.get("label_pt", 12), color=body),
                wrap=False))
        scene.add(slot, "widget", scene.text(
            x, ty - 0.32, w, 0.28,
            scene.run_rows(["%d%%" % round(v * 100)], box.get("label_pt", 12),
                           color=acc, bold=True), align="right", wrap=False))
    elif wtype == "rating":
        import solver_blocks as _sb
        v = box.get("value") or 0.0
        n = _sb.RATING_MAX
        d = 0.26
        gap = 0.12
        total = n * d + (n - 1) * gap
        sx = x + (w - total) / 2
        sy = y + h / 2 - d / 2
        for i in range(n):
            filled = (i + 0.5) <= v
            scene.add(slot, "widget", scene.shape(
                "oval", sx + i * (d + gap), sy, d, d,
                fill=(acc if filled else tokens.mix(acc, th["bg"], 0.18))))
        if box.get("label"):
            scene.add(slot, "widget", scene.text(
                x, sy + d + 0.08, w, 0.28,
                scene.run_rows(["%s %.1f/%d" % (box["label"], v, n)],
                               box.get("label_pt", 12), color=body),
                align="center", wrap=False))


# ---------------- 主入口 ----------------

_TEXT_KINDS = ("bullets", "text", "hero_kicker", "hero_title", "hero_sub", "hero_tag",
               "quote_text", "quote_attr")


def compose(layout):
    """layout → scene。逐页构造, 单页异常隔离（scene_error 信号, 不炸全 deck）。"""
    th = _theme(layout)
    W, H = layout["slide_w_in"], layout["slide_h_in"]
    sc = scene.new_scene(layout)
    sc["errors"] = []
    top_bg = layout.get("bg_image")
    for i, sl in enumerate(layout.get("slides", []), start=1):
        slot = scene.new_slide(sl.get("id") or "s%d" % i)
        try:
            stype = sl.get("type")
            is_special = stype in ("cover", "divider", "hero", "quote")
            pg_bg = sl.get("bg_image")
            inherit = None if is_special else top_bg
            eff_bg = None if pg_bg == "none" else (pg_bg or inherit)
            if stype == "hero" and th["on"]:
                _hero_default_deco(sl, th)
            pal = _palette(sl, th, eff_bg)
            _bg(slot, sl, th, pal, eff_bg, W, H)
            _deco(slot, sl, th, W, H)
            if stype == "divider":
                _divider(slot, sl, th, W, H)
                sc["slides"].append(scene.seal(slot))
                continue
            _big_page(slot, th, i, W, is_special)
            # hero=封面级页型不落页脚; quote 属内容页保留页码
            _footer(slot, layout, sl, i, W, H, is_special=(stype in ("cover", "hero")))
            for box in sl.get("boxes", []):
                kind = box.get("kind")
                if kind == "title" or kind == "hero_title":
                    _title_box(slot, box, sl, th, pal)
                elif kind == "chart":
                    _chart_box(slot, box, th)
                elif kind == "table":
                    _table_box(slot, box, th, pal)
                elif kind == "stat":
                    _stat_box(slot, box, th, pal)
                elif kind == "image":
                    _image_box(slot, box)
                elif kind == "diagram":
                    _diagram_box(slot, box, th, pal)
                elif kind == "widget":
                    _widget_box(slot, box, th, pal)
                elif kind in _TEXT_KINDS:
                    _body_box(slot, box, sl, th, pal)
                else:  # 未知 kind 的 layout 盒(容错): 按文本尽力画
                    _body_box(slot, dict(box, kind="text"), sl, th, pal)
                _overflow_mark(slot, box)
        except Exception as e:
            sc["errors"].append({"type": "scene_error", "slide": sl.get("id"),
                                 "detail": str(e)[:160]})
        sc["slides"].append(scene.seal(slot))
    return sc
