# -*- coding: utf-8 -*-
"""
png_paint.py —— v3 薄画笔: 场景图 → 每页 preview_s<i>.png（Pillow, 零测量零视觉决策）

与 pptx_paint 消费同一 scene → 两端一致由构造单源保证。
chart 是唯一"胖"原语画法（pptx 原生图表 vs 此处示意图, 后端本质不同=合法分叉,
从旧 png_view 迁入, 非复制——旧文件在 1d 删除）。
字体: 用时读 solver.FONT_PATH（live, set_font 后不串快照）。
"""

import math
import os

from PIL import Image, ImageDraw, ImageFont

import solver as _solver
import tokens

DPI = 96
_FONT_CACHE = {}


def _font(pt):
    px = max(1, round(pt * DPI / 72.0))
    key = (_solver.FONT_PATH, px)
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(_solver.FONT_PATH, px, index=0)
    return _FONT_CACHE[key]


def _px(v):
    return round(v * DPI)


def _lh(pt):
    return round(pt * DPI / 72.0 * 1.35)


def _rgb(h, default=(0, 0, 0)):
    return tokens.hex_rgb(h, default)


def _fit_text(draw, text, font, max_w):
    if draw.textlength(text, font=font) <= max_w:
        return text
    ell = "…"
    budget = max_w - draw.textlength(ell, font=font)
    if budget <= 0:
        return ell
    out = ""
    for ch in text:
        if draw.textlength(out + ch, font=font) > budget:
            break
        out += ch
    return out + ell


def _row_metrics(draw, row):
    w = sum(draw.textlength(r.get("t", ""), font=_font(r.get("pt", 14))) for r in row)
    h = max((_lh(r.get("pt", 14)) for r in row), default=_lh(14))
    return w, h


def _paint_text(img, draw, el):
    x, y, w, h = _px(el["x"]), _px(el["y"]), _px(el["w"]), _px(el["h"])
    pad = 4
    rows = el.get("runs") or [[]]
    heights = [_row_metrics(draw, row)[1] for row in rows]
    total = sum(heights)
    cy = y + (max(0, (h - total) // 2) if el.get("anchor") == "middle" else pad)
    for row, rh in zip(rows, heights):
        if cy + rh > y + h + rh:  # 超盒一行余量后停（solver 已保证行数, 此处仅防御）
            break
        rw, _ = _row_metrics(draw, row)
        if el.get("align") == "center":
            cx = x + max(pad, (w - rw) // 2)
        elif el.get("align") == "right":
            cx = x + max(pad, w - rw - pad)
        else:
            cx = x + pad
        for r in row:
            f = _font(r.get("pt", 14))
            t = r.get("t", "")
            col = _rgb(r.get("color"), (0, 0, 0))
            if r.get("bold"):
                for dx in (0, 1):
                    draw.text((cx + dx, cy), t, font=f, fill=col)
            else:
                draw.text((cx, cy), t, font=f, fill=col)
            cx += draw.textlength(t, font=f)
        cy += rh


def _overlay(img, box_px, painter, alpha):
    """带透明度的元素画在 RGBA 覆盖层再合成。"""
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    painter(ImageDraw.Draw(ov), int(max(0.0, min(1.0, alpha)) * 255))
    img.alpha_composite(ov)


def _paint_shape(img, draw, el):
    x, y = _px(el["x"]), _px(el["y"])
    x2, y2 = _px(el["x"] + el["w"]), _px(el["y"] + el["h"])
    fill = _rgb(el.get("fill")) if el.get("fill") else None
    outline = _rgb(el.get("line_color")) if el.get("line_color") else None
    lw = max(1, round(el.get("line_pt", 1.0) * DPI / 72.0)) if outline else 0

    def _p(d, a=255):
        f = fill + (a,) if fill else None
        o = outline + (255,) if outline else None
        if el.get("shape") == "oval":
            d.ellipse([x, y, x2, y2], fill=f, outline=o, width=lw)
        else:
            d.rectangle([x, y, x2, y2], fill=f, outline=o, width=lw)

    if el.get("alpha") is not None and fill:
        _overlay(img, None, _p, el["alpha"])
    else:
        _p(draw)


def _paint_line(img, draw, el):
    x1, y1 = _px(el["x1"]), _px(el["y1"])
    x2, y2 = _px(el["x2"]), _px(el["y2"])
    col = _rgb(el.get("color"))
    w = max(1, round(el.get("width_pt", 1.0) * DPI / 48.0))
    draw.line([x1, y1, x2, y2], fill=col, width=w)
    if el.get("arrow"):
        ang = math.atan2(y2 - y1, x2 - x1)
        ah = 10
        pa = (x2 - ah * math.cos(ang - 0.45), y2 - ah * math.sin(ang - 0.45))
        pb = (x2 - ah * math.cos(ang + 0.45), y2 - ah * math.sin(ang + 0.45))
        draw.polygon([(x2, y2), pa, pb], fill=col)


def _paint_gradient(img, draw, el):
    """2×2 角点图放大法: 双 stop 线性渐变的低成本近似（0/90 度精确, 斜角平滑近似）。"""
    w, h = max(1, _px(el["w"])), max(1, _px(el["h"]))
    c1 = _rgb(el.get("from"), (16, 23, 42))
    c2 = _rgb(el.get("to"), (51, 65, 85))
    ang = float(el.get("angle", 135)) % 360
    mid = tuple((a + b) // 2 for a, b in zip(c1, c2))
    if 45 <= ang < 112.5:      # ↓
        corners = [c1, c1, c2, c2]
    elif 112.5 <= ang < 202.5:  # ↘ 对角（135/180 近似同型）
        corners = [c1, mid, mid, c2]
    elif 202.5 <= ang < 292.5:  # ↑
        corners = [c2, c2, c1, c1]
    else:                       # →
        corners = [c1, c2, c1, c2]
    tiny = Image.new("RGB", (2, 2))
    tiny.putpixel((0, 0), corners[0])
    tiny.putpixel((1, 0), corners[1])
    tiny.putpixel((0, 1), corners[2])
    tiny.putpixel((1, 1), corners[3])
    grad = tiny.resize((w, h), Image.BILINEAR).convert("RGBA")
    img.alpha_composite(grad, (_px(el["x"]), _px(el["y"])))


def _paint_image(img, draw, el):
    try:
        with Image.open(el["src"]) as im:
            im2 = im.convert("RGBA").resize((max(1, _px(el["w"])), max(1, _px(el["h"]))),
                                            Image.LANCZOS)
            img.alpha_composite(im2, (_px(el["x"]), _px(el["y"])))
    except Exception:
        pass  # compose 已做占位框决策; 此处坏图静默(预览层)


def _paint_table(img, draw, el):
    x = _px(el["x"])
    w = _px(el["w"])
    col_w = el.get("col_w_in") or []
    total_w = sum(col_w) or 1.0
    col_px = [max(1, round(cw / total_w * w)) for cw in col_w]
    row_h = el.get("row_h_in") or []
    pad = 5
    cy = _px(el["y"])
    for i, row in enumerate(el.get("cells") or []):
        rh = round((row_h[i] if i < len(row_h) else 0.35) * DPI)
        fill = row[0].get("fill") if row else None
        if fill:
            draw.rectangle([x, cy, x + w, cy + rh], fill=_rgb(fill))
        cx = x
        for j, cell in enumerate(row):
            cw_px = col_px[j] if j < len(col_px) else 40
            if cell.get("fill") and cell["fill"] != fill:
                draw.rectangle([cx, cy, cx + cw_px, cy + rh], fill=_rgb(cell["fill"]))
            rows = cell.get("rows") or []
            heights = [_row_metrics(draw, r)[1] for r in rows]
            ty = cy + max(0, (rh - sum(heights)) // 2)
            for rrow, rhh in zip(rows, heights):
                if ty + rhh > cy + rh + 2:
                    break
                tx = cx + pad
                for r in rrow:
                    f = _font(r.get("pt", 12))
                    t = _fit_text(draw, r.get("t", ""), f, cw_px - 2 * pad)
                    col = _rgb(r.get("color"), (0, 0, 0))
                    if r.get("bold"):
                        for dx in (0, 1):
                            draw.text((tx + dx, ty), t, font=f, fill=col)
                    else:
                        draw.text((tx, ty), t, font=f, fill=col)
                    tx += draw.textlength(r.get("t", ""), font=f)
                ty += rhh
            cx += cw_px
        cy += rh
        draw.line([x, cy, x + w, cy], fill=_rgb(el.get("sep_color", "DDDDDD")), width=1)


# ---- chart 示意画法（自旧 png_view 迁入, 1d 删旧源）----
_SERIES_PALETTE = [(0x44, 0x72, 0xC4), (0xED, 0x7D, 0x31), (0x70, 0xAD, 0x47),
                   (0xFF, 0xC0, 0x00), (0xA5, 0xA5, 0xA5), (0x5B, 0x9B, 0xD5)]


def _series_colors(n, accent):
    return [(accent if i == 0 and accent else _SERIES_PALETTE[i % len(_SERIES_PALETTE)])
            for i in range(n)]


def _all_values(series):
    vals = []
    for s in series or []:
        for v in (s.get("values") or []):
            try:
                vals.append(float(v))
            except (TypeError, ValueError):
                pass
    return vals


def _paint_chart(img, draw, el):
    x, y, w, h = _px(el["x"]), _px(el["y"]), _px(el["w"]), _px(el["h"])
    accent = _rgb(el.get("accent")) if el.get("accent") else (0x44, 0x72, 0xC4)
    series = el.get("series") or []
    categories = el.get("categories") or []
    draw.rectangle([x, y, x + w, y + h], fill=(255, 255, 255), outline=(0, 0, 0), width=2)
    pad = 10
    title_h = 0
    if el.get("title"):
        tf = _font(14)
        draw.text((x + pad, y + pad), _fit_text(draw, el["title"], tf, w - 2 * pad),
                  font=tf, fill=(0, 0, 0))
        title_h = _lh(14)
    cat_h = _lh(11) if categories else 0
    px0, py0 = x + pad, y + pad + title_h + 4
    px1, py1 = x + w - pad, y + h - pad - cat_h
    pw, ph = px1 - px0, py1 - py0
    if pw <= 4 or ph <= 4:
        return
    cols = _series_colors(len(series), accent)
    named = [s for s in series if s.get("name")]
    if len(series) > 1 and named:
        lf = _font(10)
        lx = px1
        for si in range(len(series) - 1, -1, -1):
            name = str(series[si].get("name", ""))
            if not name:
                continue
            lx -= draw.textlength(name, font=lf) + 16
            draw.rectangle([lx, y + pad + 2, lx + 9, y + pad + 11], fill=cols[si])
            draw.text((lx + 12, y + pad), name, font=lf, fill=(0x66, 0x66, 0x66))
        py0 += 4
        ph = py1 - py0
    ct = el.get("chart_type", "bar")
    vals = _all_values(series)
    maxv = max(vals) if vals else 1.0
    maxv = maxv if maxv > 0 else 1.0
    if ct == "pie":
        s0 = series[0] if series else {"values": []}
        vlist = [max(0.0, float(v)) if isinstance(v, (int, float)) else 0.0
                 for v in (s0.get("values") or [])]
        total = sum(vlist)
        d = min(pw, ph) - 4
        if d > 4 and total > 0:
            cx, cy0 = px0 + pw / 2, py0 + ph / 2
            bbox = [cx - d / 2, cy0 - d / 2, cx + d / 2, cy0 + d / 2]
            start = -90.0
            for i, v in enumerate(vlist):
                sweep = (v / total) * 360.0
                col = cols[0] if i == 0 else _SERIES_PALETTE[i % len(_SERIES_PALETTE)]
                draw.pieslice(bbox, start, start + sweep, fill=col, outline=(255, 255, 255))
                start += sweep
    elif ct == "line":
        baseline = py0 + ph
        draw.line([px0, baseline, px0 + pw, baseline], fill=(0, 0, 0), width=1)
        for si, s in enumerate(series):
            vlist = s.get("values") or []
            n = len(vlist)
            if not n:
                continue
            step = pw / max(1, n - 1) if n > 1 else pw
            pts = []
            for i, v in enumerate(vlist):
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    fv = 0.0
                pts.append((px0 + (step * i if n > 1 else pw / 2),
                            baseline - (fv / maxv) * (ph - 2)))
            if len(pts) >= 2:
                draw.line(pts, fill=cols[si], width=2)
            for (cx, cy0) in pts:
                draw.ellipse([cx - 3, cy0 - 3, cx + 3, cy0 + 3], fill=cols[si])
    else:  # bar
        n_cat = max(1, len(categories) or (len(series[0].get("values", [])) if series else 1))
        n_ser = max(1, len(series))
        group_w = pw / n_cat
        bar_w = max(2, (group_w - 6) / n_ser - 2)
        baseline = py0 + ph
        draw.line([px0, baseline, px0 + pw, baseline], fill=(0, 0, 0), width=1)
        vf = _font(9)
        for ci in range(n_cat):
            gx = px0 + group_w * ci + 3
            for si, s in enumerate(series):
                vlist = s.get("values") or []
                if ci >= len(vlist):
                    continue
                try:
                    v = float(vlist[ci])
                except (TypeError, ValueError):
                    continue
                bh = (v / maxv) * (ph - 16)
                bx0 = gx + si * (bar_w + 2)
                draw.rectangle([bx0, baseline - bh, bx0 + bar_w, baseline], fill=cols[si])
                vtxt = "%g" % v
                vw = draw.textlength(vtxt, font=vf)
                if vw <= bar_w + 4:
                    draw.text((bx0 + (bar_w - vw) / 2, baseline - bh - 13), vtxt,
                              font=vf, fill=(0x66, 0x66, 0x66))
    if categories and cat_h and ct != "pie":
        cf = _font(11)
        slot = pw / max(1, len(categories))
        for i, c in enumerate(categories):
            label = _fit_text(draw, str(c), cf, slot - 2)
            lw = draw.textlength(label, font=cf)
            draw.text((px0 + slot * i + (slot - lw) / 2, py1 + 2), label,
                      font=cf, fill=(0x66, 0x66, 0x66))


def render_png_scene(sc, out_dir):
    """场景图 → 每页 preview_s<i>.png。返回 (paths, errors)。"""
    os.makedirs(out_dir, exist_ok=True)
    W = round(float(sc["slide_w_in"]) * DPI)
    H = round(float(sc["slide_h_in"]) * DPI)
    paths, errors = [], []
    def paint(img, draw, el):
        p = el.get("p")
        if p == "text":
            _paint_text(img, draw, el)
        elif p == "shape":
            _paint_shape(img, draw, el)
        elif p == "line":
            _paint_line(img, draw, el)
        elif p == "gradient":
            _paint_gradient(img, draw, el)
        elif p == "image":
            _paint_image(img, draw, el)
        elif p == "table":
            _paint_table(img, draw, el)
        elif p == "chart":
            _paint_chart(img, draw, el)
        elif p == "group":
            for sub in (el.get("items") or []):
                paint(img, draw, sub)

    for i, sl in enumerate(sc.get("slides", []), start=1):
        img = Image.new("RGBA", (W, H), (255, 255, 255, 255))
        draw = ImageDraw.Draw(img)
        for el in sl.get("elements", []):
            try:
                paint(img, draw, el)
            except Exception as e:
                errors.append({"type": "paint_error", "slide": sl.get("id"),
                               "p": el.get("p"), "detail": str(e)[:120]})
        out = os.path.join(out_dir, "preview_s%d.png" % i)
        img.convert("RGB").save(out, "PNG")
        paths.append(out)
    return paths, errors
