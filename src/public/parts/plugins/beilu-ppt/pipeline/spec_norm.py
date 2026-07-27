# -*- coding: utf-8 -*-
"""
spec_norm.py —— spec 归一层（v2.6 自 solver.py 拆出, 凛倾 0717"大文件拆分≤1000行"）

职责: 进布局前把 AI 产出的 spec 归一到契约值域（v1.7 算法容错域）。
  - kind/region/style/type 小写去空白 + 别名映射; slides/blocks 非对象项丢弃
  - chart/table/bullets/diagram 数据域强制归位（坏数据曾穿透渲染层炸全 deck）
  - emoji/图形符号剔除（渲染字体无字形 → 豆腐块）
只做确定性归位不猜测; 丢弃/回退发信号不静默。
调用点单源: pipeline.run（solve 不重复跑, 防信号翻倍）。
功能链: pipeline.run → normalize_spec(spec) → solver.solve
"""

import re

KIND_ALIASES = {"bullet": "bullets", "list": "bullets", "img": "image", "picture": "image",
                "pic": "image", "graph": "chart", "statistic": "stat", "tbl": "table",
                "paragraph": "text", "flow": "diagram", "flowchart": "diagram",
                "process": "diagram"}
REGION_ALIASES = {"middle": "center", "centre": "center", "mid": "center"}
VALID_REGIONS = ("left", "center", "right", "top", "bottom", "full")

# v1.7: emoji/图形符号剔除——渲染字体(微软雅黑)无此类字形, 且 PIL 无系统字体回退机制,
# 量测/绘制双双出豆腐块(0717 实拍: "🔥 热记忆"→"□ 热记忆")。
# 剔除域=emoji 主区 1F000-1FAFF + 杂项符号/装饰符全区 2600-27BF + 2B00-2BFF + 变体选择符/ZWJ。
# v3.2 字符容错扩域（AI 输出字符可含 XML 非法/不可见字符, 归一单点拦截）:
#   C0 控制符(留 \t\n)/C1/DEL——lxml 对 XML 非法字符直接 ValueError, 整元素丢失;
#   零宽系(200B/200C/2060/FEFF)——污染 PIL 度量与断行; 行/段分隔符(2028/2029)——JSON 合法
#   但渲染语义诡异; 孤立代理对(D800-DFFF)/非字符(FFFE/FFFF)——utf-8 落盘即炸。
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0E\uFE0F\u200D"
    "\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f"
    "\u200B\u200C\u2060\uFEFF\u2028\u2029"
    "\ud800-\udfff\ufffe\uffff]")


def _strip_emoji(s, counter):
    t = _EMOJI_RE.sub("", s)
    if t != s:
        counter[0] += 1
        t = re.sub(r"  +", " ", t).strip()
    return t


def _strip_emoji_fields(b, counter):
    """块级文本字段全覆盖剔除（items/headers/rows/nodes 等列表字段逐元素）。"""
    for key in ("text", "title", "label", "value", "placeholder", "caption", "chart_type"):
        if isinstance(b.get(key), str):
            b[key] = _strip_emoji(b[key], counter)
    if isinstance(b.get("items"), list):
        b["items"] = [_strip_emoji(x, counter) if isinstance(x, str) else x for x in b["items"]]
    if isinstance(b.get("headers"), list):
        b["headers"] = [_strip_emoji(x, counter) if isinstance(x, str) else x for x in b["headers"]]
    if isinstance(b.get("rows"), list):
        b["rows"] = [[_strip_emoji(c, counter) if isinstance(c, str) else c for c in r0]
                     if isinstance(r0, list) else r0 for r0 in b["rows"]]
    if isinstance(b.get("nodes"), list):  # v2.6 diagram
        for nd in b["nodes"]:
            if isinstance(nd, dict):
                for k2 in ("label", "sub"):
                    if isinstance(nd.get(k2), str):
                        nd[k2] = _strip_emoji(nd[k2], counter)


def _norm_diagram(b, sigs):
    """
    v2.6 diagram 数据域归位: nodes → [{"id","label","sub"}...]（字符串项收编为 {label}）,
    edges → [[src,dst,label?]...]（非法项丢弃）。无有效节点 → 降级 text + invalid_data 信号
    （同 chart/table 惯例: layout 是渲染器唯一输入源, 渲染层不再校验）。
    """
    ok_nodes = []
    for i, nd in enumerate(b.get("nodes") or []):
        if isinstance(nd, str) and nd.strip():
            ok_nodes.append({"id": "n%d" % i, "label": nd.strip(), "sub": ""})
        elif isinstance(nd, dict):
            label = str(nd.get("label") or nd.get("text") or "").strip()
            if label:
                ok_nodes.append({"id": str(nd.get("id") or "n%d" % i),
                                 "label": label, "sub": str(nd.get("sub") or "")})
    ok_edges = []
    ids = {nd["id"] for nd in ok_nodes}
    for e in (b.get("edges") or []):
        if isinstance(e, (list, tuple)) and len(e) >= 2:
            a, c = str(e[0]), str(e[1])
            if a in ids and c in ids:
                ok_edges.append([a, c, str(e[2]) if len(e) > 2 else ""])
    if not ok_nodes:
        sigs.append({"type": "invalid_data", "block_id": b.get("id"),
                     "detail": "diagram nodes 数据无效, 已降级为文字占位"})
        b["kind"] = "text"
        b["text"] = "[图解数据无效: %s]" % str(b.get("id") or "")
        return
    b["nodes"] = ok_nodes
    b["edges"] = ok_edges
    d = str(b.get("direction", "lr")).strip().lower()
    b["direction"] = d if d in ("lr", "tb") else "lr"


DECO_TYPES = ("gradient_bg", "circle", "rect", "line", "art")
WIDGET_TYPES = ("badge", "progress", "rating")


def _hex6(v):
    """色值清洗: 'RRGGBB'（容错带#）→ 合法 hex6 或 None。"""
    if not isinstance(v, str):
        return None
    v = v.lstrip("#").strip()
    if len(v) == 6:
        try:
            int(v, 16)
            return v.upper()
        except ValueError:
            pass
    return None


def _norm_deco(sl, sigs):
    """
    v2.7 装饰组件归一（视觉收编: 参数化装饰替代整页截图）: slide.deco=[{type,...}]。
    未知 type/非法项丢弃+信号; 色值清洗; 数值域强转 float（坐标钳制在 solver 做——画布尺寸此时未定）。
    """
    out = []
    for i, d in enumerate(sl.get("deco") or []):
        if not isinstance(d, dict) or str(d.get("type", "")).strip().lower() not in DECO_TYPES:
            sigs.append({"type": "deco_invalid", "slide": sl.get("id"),
                         "detail": "deco[%d] 未知类型 %r 已丢弃(可用 %s)"
                                   % (i, (d or {}).get("type") if isinstance(d, dict) else d,
                                      "|".join(DECO_TYPES))})
            continue
        nd = {"type": str(d["type"]).strip().lower()}
        if nd["type"] == "art":
            # v3.1: 前端小图组件——html/svg 代码经 Chrome 透明底渲小图放装饰层（文字禁进 art）
            mk = d.get("html") or d.get("svg")
            if not isinstance(mk, str) or "<" not in mk:
                sigs.append({"type": "deco_invalid", "slide": sl.get("id"),
                             "detail": "deco[%d] art 缺 html/svg 标记, 已丢弃" % i})
                continue
            nd["html"] = mk
        # v3.2 锚定参数: anchor=语义块id(字符串), w/h 可为 "match"（取块尺寸, solver 解析）
        if isinstance(d.get("anchor"), str) and d["anchor"].strip():
            nd["anchor"] = d["anchor"].strip()
        for mk2 in ("w", "h"):
            if d.get(mk2) == "match":
                nd[mk2] = "match"
        for ck in ("color", "from", "to"):
            if d.get(ck) is not None:
                h = _hex6(d[ck])
                if h:
                    nd[ck] = h
        for nk in ("x", "y", "w", "h", "r", "x1", "y1", "x2", "y2", "angle", "alpha",
                   "width_pt", "dx", "dy"):
            if d.get(nk) is not None:
                try:
                    nd[nk] = float(d[nk])
                except (TypeError, ValueError):
                    pass
        out.append(nd)
    if out:
        sl["deco"] = out
    elif "deco" in sl:
        del sl["deco"]


def _migrate_html_page(sl, sigs):
    """
    v2.7 整页截图路线废除（凛倾: 组装出来的每层都是组件; 0717 补充定案: 前端代码只用于
    美化小组件转小图——整页转换会带来编辑与转换的大问题, 不做）:
    type:"html" 页 → html/svg 迁入 bg_html（装饰背景层）, type 清空按普通页排,
    发 deprecation 信号引导改用 hero/quote + deco（含 art 小图组件）+语义块。
    """
    markup = sl.get("html") or sl.get("svg")
    if markup and not sl.get("bg_html"):
        sl["bg_html"] = markup
    sl.pop("html", None)
    sl.pop("svg", None)
    sl["type"] = None
    sigs.append({"type": "html_page_deprecated", "slide": sl.get("id"),
                 "detail": "整页 html 已废除: 代码已转为背景装饰层, 正文文字请用 title/blocks,"
                           " 强设计页改用 type=hero/quote + deco 装饰（含 art 前端小图组件）"})


def normalize_spec(spec):
    """
    进布局前把 AI 产出的 spec 归一到契约值域: kind/region/style/type 小写去空白+别名映射,
    slides/blocks 非对象项丢弃。只做确定性归位不猜测; 丢弃/回退发信号不静默
    （大小写与别名归一属无损归位, 不发信号; unknown kind 留给 _make_box 的 unknown_kind 信号）。
    返回 norm 信号列表（pipeline 汇总, 不进回程闭环——闭环策略修不了这类, 防空转 max_iter）。
    """
    sigs = []
    emoji_n = [0]
    meta = spec.get("meta")
    if isinstance(meta, dict) and isinstance(meta.get("title"), str):
        meta["title"] = _strip_emoji(meta["title"], emoji_n)
    slides = spec.get("slides")
    if not isinstance(slides, list):
        spec["slides"] = []
        sigs.append({"type": "spec_invalid", "detail": "slides 非数组, 已置空"})
        return sigs
    kept = []
    for idx, sl in enumerate(slides):
        if not isinstance(sl, dict):
            sigs.append({"type": "spec_invalid",
                         "detail": "slides[%d] 非对象已丢弃: %r" % (idx, str(sl)[:60])})
            continue
        if isinstance(sl.get("type"), str):
            sl["type"] = sl["type"].strip().lower()
        if sl.get("type") == "html":
            _migrate_html_page(sl, sigs)  # v2.7 整页截图废除→装饰层
        if sl.get("type") in ("hero", "quote"):
            # v2.7 新页型文本域清洗（hero: title/subtitle/kicker/tagline; quote: text/attribution）
            for tk in ("title", "subtitle", "kicker", "tagline", "text", "attribution"):
                if isinstance(sl.get(tk), str):
                    sl[tk] = _strip_emoji(sl[tk], emoji_n)
        _norm_deco(sl, sigs)
        if isinstance(sl.get("title"), str):
            sl["title"] = _strip_emoji(sl["title"], emoji_n)
        if isinstance(sl.get("number"), str):  # divider 编号（v3.2 字符净化补漏）
            sl["number"] = _strip_emoji(sl["number"], emoji_n)
        if sl.get("blocks") is not None and not isinstance(sl.get("blocks"), list):
            sigs.append({"type": "spec_invalid", "slide": sl.get("id", "s%d" % idx),
                         "detail": "blocks 非数组, 已置空"})
            sl["blocks"] = []
        kept_b = []
        for bi, b in enumerate(sl.get("blocks") or []):
            if not isinstance(b, dict):
                sigs.append({"type": "spec_invalid", "slide": sl.get("id", "s%d" % idx),
                             "detail": "blocks[%d] 非对象已丢弃" % bi})
                continue
            k = str(b.get("kind", "text")).strip().lower()
            b["kind"] = KIND_ALIASES.get(k, k)
            # 数据域强制归位（契约: layout 是渲染器唯一输入源, 渲染层不再校验——
            # 坏 series 曾穿透到 png_view _draw_chart AttributeError 炸全 deck, 0717 酷刑测试实证）
            if b["kind"] == "chart":
                cats = b.get("categories")
                b["categories"] = [str(c) for c in cats] if isinstance(cats, list) else []
                ok_sers = []
                if isinstance(b.get("series"), list):
                    for s0 in b["series"]:
                        if isinstance(s0, dict) and isinstance(s0.get("values"), list):
                            vals = [v for v in s0["values"] if isinstance(v, (int, float))]
                            if vals:
                                ok_sers.append({"name": str(s0.get("name", "")), "values": vals})
                if ok_sers:
                    b["series"] = ok_sers
                else:
                    sigs.append({"type": "invalid_data", "block_id": b.get("id"),
                                 "detail": "chart categories/series 数据无效, 已降级为文字占位"})
                    b["kind"] = "text"
                    b["text"] = "[图表数据无效: %s]" % str(b.get("title") or b.get("id") or "")
            elif b["kind"] == "table":
                hdrs, rows = b.get("headers"), b.get("rows")
                b["headers"] = [str(h) for h in hdrs] if isinstance(hdrs, list) else []
                b["rows"] = ([[str(c) for c in r0] for r0 in rows if isinstance(r0, list)]
                             if isinstance(rows, list) else [])
                if not b["headers"] and not b["rows"]:
                    sigs.append({"type": "invalid_data", "block_id": b.get("id"),
                                 "detail": "table headers/rows 数据无效, 已降级为文字占位"})
                    b["kind"] = "text"
                    b["text"] = "[表格数据无效: %s]" % str(b.get("id") or "")
            elif b["kind"] == "bullets":
                its = b.get("items")
                b["items"] = ([str(x) for x in its] if isinstance(its, list)
                              else ([str(its)] if its is not None else []))
            elif b["kind"] == "diagram":
                _norm_diagram(b, sigs)
            elif b["kind"] == "widget":
                # v2.7 小配件组件: 单独定义/单独渲染/最后组装（原生形状+文字, 全可编辑）
                w = str(b.get("widget", "")).strip().lower()
                if w not in WIDGET_TYPES:
                    sigs.append({"type": "invalid_data", "block_id": b.get("id"),
                                 "detail": "widget 类型 %r 无效(可用 %s), 已降级为文字占位"
                                           % (b.get("widget"), "|".join(WIDGET_TYPES))})
                    b["kind"] = "text"
                    b["text"] = "[配件类型无效: %s]" % str(b.get("id") or "")
                else:
                    b["widget"] = w
                    if b.get("color") is not None:
                        b["color"] = _hex6(b["color"]) or None
                    try:
                        b["value"] = float(b.get("value")) if b.get("value") is not None else None
                    except (TypeError, ValueError):
                        b["value"] = None
            _strip_emoji_fields(b, emoji_n)
            r = str(b.get("region", "center")).strip().lower()
            r = REGION_ALIASES.get(r, r)
            if r not in VALID_REGIONS:
                sigs.append({"type": "region_fallback", "block_id": b.get("id"),
                             "detail": "未知 region %r 已回退 center" % b.get("region")})
                r = "center"
            b["region"] = r
            if isinstance(b.get("style"), str):
                b["style"] = b["style"].strip().lower()
            kept_b.append(b)
        sl["blocks"] = kept_b
        kept.append(sl)
    spec["slides"] = kept
    if emoji_n[0]:
        sigs.append({"type": "emoji_stripped",
                     "detail": "%d 处 emoji/图形符号已剔除(渲染字体无字形会成方框); 图形语义请改用 image 块或 style=icon" % emoji_n[0]})
    return sigs
