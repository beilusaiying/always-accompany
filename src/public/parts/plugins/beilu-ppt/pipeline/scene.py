# -*- coding: utf-8 -*-
"""
scene.py —— v3 场景图 IR（算法层→渲染层的唯一契约）

设计（v3框架设计_场景图渲染架构.md §三）:
  场景 = {slide_w_in, slide_h_in, font, slides:[{id, elements:[元素…]}]}
  元素 = 原语 dict, 必带 "p"(原语名)+"z"(图层基数+层内序), 坐标一律英寸。
  8 种原语: text / shape / line / gradient / image / table / chart / group
  五图层 z 基数见 tokens.LAYER_Z; 渲染端按 z 升序画, 禁任何测量与决策。

text 原语 runs 结构: runs=[行…], 行=[run…], run={t,pt,bold?,color?}
  —— `**` 强调/标题加粗/表头反白全部在 compose 落成 run 属性, 画笔只照画。

本模块只提供: 构造器(add)/校验(validate_scene)/排序迭代(iter_sorted)。零视觉决策。
功能链: compose.py 构造 → scene.json 落盘 → png_paint/pptx_paint 消费
"""

import tokens

PRIMITIVES = ("text", "shape", "line", "gradient", "image", "table", "chart", "group")


def new_scene(layout):
    return {
        "slide_w_in": layout["slide_w_in"],
        "slide_h_in": layout["slide_h_in"],
        "font": layout["font"],
        "slides": [],
    }


def new_slide(sid):
    return {"id": sid, "elements": [], "_layer_seq": {}}


def add(sl, layer, el):
    """按图层追加元素并分配 z（图层基数 + 层内序, 层内最多 9 序位够用且防跨层越界）。"""
    base = tokens.LAYER_Z[layer]
    seq = sl["_layer_seq"].get(layer, 0)
    sl["_layer_seq"][layer] = seq + 1
    el["z"] = base + min(seq, 9) * 0.5  # 半步长: 单层理论容量 20 元素级, 超出并 z 同序稳定排序兜底
    el["layer"] = layer
    sl["elements"].append(el)
    return el


def seal(sl):
    """构造完成: 排序+去内部态。"""
    sl["elements"].sort(key=lambda e: e["z"])
    sl.pop("_layer_seq", None)
    return sl


def iter_sorted(sl):
    return sorted(sl.get("elements", []), key=lambda e: e.get("z", 0))


def text(x, y, w, h, runs, align="left", anchor="top", wrap=True):
    return {"p": "text", "x": x, "y": y, "w": w, "h": h,
            "runs": runs, "align": align, "anchor": anchor, "wrap": wrap}


def run_rows(lines, pt, color=None, bold=False, accents=None, accent_color=None,
             accent_bold=True):
    """
    lines(纯文本行) → runs 二维数组。accents 命中的子串切独立 run（bold+accent 色）——
    v1.0 强调机制在 IR 层的唯一落点（原 png/pptx 双份 _split_by_accents 收编于此）。
    """
    rows = []
    for line in (lines if lines else [""]):
        segs = [(line, False)]
        for wd in (accents or []):
            out = []
            for txt, hit in segs:
                if hit or wd not in txt:
                    out.append((txt, hit))
                    continue
                i = txt.find(wd)
                if i > 0:
                    out.append((txt[:i], False))
                out.append((wd, True))
                if i + len(wd) < len(txt):
                    out.append((txt[i + len(wd):], False))
            segs = out
        row = []
        for seg, hit in segs:
            r = {"t": seg, "pt": pt, "bold": bold or (hit and accent_bold)}
            c = (accent_color if hit and accent_color else color)
            if c:
                r["color"] = c
            row.append(r)
        rows.append(row)
    return rows


def shape(kind, x, y, w, h, fill=None, line_color=None, line_pt=None, alpha=None):
    el = {"p": "shape", "shape": kind, "x": x, "y": y, "w": w, "h": h}
    if fill:
        el["fill"] = fill
    if line_color:
        el["line_color"] = line_color
        el["line_pt"] = line_pt or 1.0
    if alpha is not None:
        el["alpha"] = alpha
    return el


def line(x1, y1, x2, y2, color, width_pt=1.0, arrow=False):
    return {"p": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "color": color, "width_pt": width_pt, "arrow": arrow}


def gradient(x, y, w, h, c_from, c_to, angle=135):
    return {"p": "gradient", "x": x, "y": y, "w": w, "h": h,
            "from": c_from, "to": c_to, "angle": angle}


def image(src, x, y, w, h):
    return {"p": "image", "src": src, "x": x, "y": y, "w": w, "h": h}


def validate_scene(scene):
    """结构校验（自测/回归用）: 返回问题列表, 空=通过。"""
    probs = []
    for si, sl in enumerate(scene.get("slides", [])):
        prev_z = -1
        for ei, el in enumerate(sl.get("elements", [])):
            tag = "s%d.e%d" % (si, ei)
            if el.get("p") not in PRIMITIVES:
                probs.append("%s 未知原语 %r" % (tag, el.get("p")))
            if "z" not in el:
                probs.append("%s 缺 z" % tag)
            elif el["z"] < prev_z:
                probs.append("%s z 未升序" % tag)
            else:
                prev_z = el["z"]
            if el.get("p") == "text":
                if not isinstance(el.get("runs"), list) or not all(
                        isinstance(row, list) for row in el["runs"]):
                    probs.append("%s runs 非二维数组" % tag)
    return probs
