# -*- coding: utf-8 -*-
"""
solver.py —— ppt_ascii_pipeline_v0 的几何求解器（分身A）

职责（见 CONTRACT.md）：spec.json -> layout.json
  - 单源原则：solver 是唯一做换行和坐标计算的地方；三个渲染器只消费本文件算好的
    lines 与坐标，禁止自己重新换行/测量。
  - 用真实字体度量（PIL ImageFont 加载 msyh.ttc）做中文逐字符换行。
  - 按契约"布局算法"7 条确定性规则求坐标，字号降级失败则发 overflow 信号。

度量约定（契约 §画布常量，不得改）：
  - ImageFont.truetype(path, size=font_pt) 时 1pt=1px
  - 宽度英寸 = textlength_px / 72
  - 行高英寸 = font_pt * 1.35 / 72
  - 文本可用宽度 = 盒宽 * 0.92（安全边距）

功能链：pipeline.py -> solve(spec) -> layout -> {ascii,png,pptx}_view 消费
"""

import io
import json
import re
import sys
from PIL import ImageFont

import style_packs
import themes
import spec_norm  # v2.6 拆分: 归一层单源（无反向依赖, 顶部安全导入）

# v2.6 拆分配套: solver_blocks 经 `import solver` 反向引用本模块（度量 live 绑定）。
# 直跑 `python solver.py` 时本模块名是 __main__——先注册别名, 防同文件二次加载出双实例
# （双实例=set_font/set_canvas 状态分叉 + 循环导入撞半初始化模块 AttributeError, 实测崩溃形态）。
sys.modules.setdefault("solver", sys.modules[__name__])

# Windows 控制台默认 GBK，无法输出 "•" 等字符；自测 print 前把 stdout 切到 UTF-8。
# 仅影响本文件 __main__ 自测的显示，不影响 solve() 返回值。
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# ---- 画布常量（契约 §画布常量，所有模块一致，禁止本地魔改）----
SLIDE_W_IN = 13.333
SLIDE_H_IN = 7.5

# v2.2 画布参数化（凛倾0717"画布的大型考虑过没有"——16:9 曾全链写死, 最后一块硬编码域）:
# meta.canvas = 预设名 | {"w_in","h_in"} | "宽x高"(英寸)。set_canvas 是唯一改点,
# 派生几何(TITLE_W)同步重算; png/ascii/pptx/自由页渲染尺寸/准度体检全从 layout 尺寸派生。
CANVAS_PRESETS = {
    "16:9": (13.333, 7.5),
    "4:3": (10.0, 7.5),
    "9:16": (7.5, 13.333),   # 竖版(2026 趋势采集: 竖版增长最快)
    "a4": (11.69, 8.27),
}
_DEFAULT_CANVAS = (13.333, 7.5)


def set_canvas(val):
    """画布切换（None/缺省=重置 16:9）。返回 None 或 canvas_fallback 信号（退默认不阻断）。"""
    global SLIDE_W_IN, SLIDE_H_IN, TITLE_W
    w = h = None
    if val is None or (isinstance(val, str) and not val.strip()):
        w, h = _DEFAULT_CANVAS
    elif isinstance(val, str):
        key = val.strip().lower().replace("：", ":").replace("？", "")
        if key in CANVAS_PRESETS:
            w, h = CANVAS_PRESETS[key]
        else:
            import re as _re3
            m = _re3.match(r"^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)$", key)
            if m:
                w, h = float(m.group(1)), float(m.group(2))
    elif isinstance(val, dict):
        try:
            w, h = float(val.get("w_in")), float(val.get("h_in"))
        except (TypeError, ValueError):
            w = h = None
    sig = None
    if not (w and h and 5.0 <= w <= 30.0 and 5.0 <= h <= 30.0):
        if val is not None and not (isinstance(val, str) and not val.strip()):
            sig = {"type": "canvas_fallback", "value": str(val)[:60],
                   "detail": "画布无效(预设 %s / 宽x高英寸 / {w_in,h_in}, 值域5-30in), 已退 16:9"
                             % "|".join(CANVAS_PRESETS)}
        w, h = _DEFAULT_CANVAS
    SLIDE_W_IN, SLIDE_H_IN = round(w, 3), round(h, 3)
    TITLE_W = SLIDE_W_IN - 2 * TITLE_X  # 派生几何同步重算
    return sig


def _resolve_font_path():
    """中文字体解析：env BEILU_PPT_FONT > 平台候选。度量与 PNG 渲染同源（CONTRACT: 1pt=1px）。
    找不到 fail-loud——字体是核心链硬依赖（实测字宽换行），不静默降级。"""
    import os
    import sys as _sys
    cand = [os.environ.get("BEILU_PPT_FONT", "")]
    if _sys.platform == "win32":
        cand += ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simsun.ttc"]
    elif _sys.platform == "darwin":
        cand += ["/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Light.ttc"]
    else:
        cand += ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                 "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
                 "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"]
    for c in cand:
        if c and os.path.exists(c):
            return c
    raise FileNotFoundError(
        "未找到中文字体：请设置环境变量 BEILU_PPT_FONT 指向一个 .ttf/.ttc 文件"
        "（管线用它做文字实测度量与 PNG 渲染）")


FONT_PATH = _resolve_font_path()
FONT_NAME = "微软雅黑"
_DEFAULT_FONT_PATH = FONT_PATH
_DEFAULT_FONT_NAME = FONT_NAME

# v2.1 字体接线（spec meta.font 原为死字段、pptx 名写死——0717 验收核出的硬编码）:
# 名→文件内置候选 + themes 覆盖层 "fonts" 段用户可扩 + 直接给文件路径也认。
# 度量与渲染同源铁约束: set_font 是唯一改点, 名与度量文件必须一起换
# （png_view 用时读 solver.FONT_PATH 非 import 快照, 两端自然同步）。
# [0719 跨平台] 每个中文字体名一条跨平台候选链（set_font 取第一个存在的文件）：
#   Windows 原生 → mac（PingFang/Hiragino/Songti/Kaiti 系统自带含中文字形）→
#   linux（Noto CJK 两个常见落位 + 文泉驿）。候选必须真含中文字形——非 Windows 上
#   中文渲染不能退到无字形的西文字体（凛倾 0719「注意中文」）。黑体系与衬线系分别对位。
_CJK_SANS_FALLBACK = [
    "/System/Library/Fonts/PingFang.ttc",                       # mac 苹方
    "/System/Library/Fonts/Hiragino Sans GB.ttc",               # mac 冬青黑体简
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",   # debian/ubuntu Noto 黑
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",        # arch/fedora Noto 黑
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",           # 文泉驿微米黑
]
_CJK_SERIF_FALLBACK = [
    "/System/Library/Fonts/Supplemental/Songti.ttc",            # mac 宋体
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",  # debian/ubuntu Noto 宋
    "/usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc",       # arch/fedora Noto 宋
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",             # 文泉驿正黑（衬线缺失兜底，仍含中文字形）
]
FONT_ALIASES = {
    "微软雅黑": ["C:/Windows/Fonts/msyh.ttc"] + _CJK_SANS_FALLBACK,
    "黑体": ["C:/Windows/Fonts/simhei.ttf"] + _CJK_SANS_FALLBACK,
    "宋体": ["C:/Windows/Fonts/simsun.ttc"] + _CJK_SERIF_FALLBACK,
    "楷体": ["C:/Windows/Fonts/simkai.ttf", "/System/Library/Fonts/Supplemental/Kaiti.ttc"] + _CJK_SERIF_FALLBACK,
    "仿宋": ["C:/Windows/Fonts/simfang.ttf"] + _CJK_SERIF_FALLBACK,
    "等线": ["C:/Windows/Fonts/Deng.ttf"] + _CJK_SANS_FALLBACK,
    "苹方": ["/System/Library/Fonts/PingFang.ttc"] + _CJK_SANS_FALLBACK[1:],
}


def set_font(name):
    """
    按 spec meta.font 切字体（度量文件+pptx 字体名同步）。返回 None 或降级信号 dict。
    查找序: 覆盖层 fonts{名:路径} > 内置 FONT_ALIASES > name 本身是存在的字体文件路径。
    未命中→退默认+font_fallback 信号（不阻断, 离线硬约束）。空/缺省→重置默认。
    """
    global FONT_PATH, FONT_NAME
    import os as _os2
    if not name or not isinstance(name, str) or not name.strip():
        FONT_PATH, FONT_NAME = _DEFAULT_FONT_PATH, _DEFAULT_FONT_NAME
        _refresh_bullet()
        return None
    name = name.strip()
    if name == FONT_NAME:
        return None
    import themes as _th
    overlay_fonts = {str(k): str(v) for k, v in (_th._OVERLAY.get("fonts") or {}).items()}
    cands = []
    if name in overlay_fonts:
        cands.append((name, overlay_fonts[name]))
    for p in FONT_ALIASES.get(name, []):
        cands.append((name, p))
    if _os2.path.isfile(name) and name.lower().endswith((".ttf", ".ttc", ".otf")):
        cands.append((_os2.path.splitext(_os2.path.basename(name))[0], name))
    for disp_name, p in cands:
        if p and _os2.path.isfile(p):
            FONT_PATH, FONT_NAME = p, disp_name
            _refresh_bullet()  # bullet 符号随字体字形能力重选
            return None
    FONT_PATH, FONT_NAME = _DEFAULT_FONT_PATH, _DEFAULT_FONT_NAME
    return {"type": "font_fallback", "name": name,
            "detail": "字体未找到(覆盖层fonts/内置名单/文件路径均未命中), 已退默认 %s" % FONT_NAME}

# 标题带
TITLE_X = 0.6                 # 左右边距 0.6"
TITLE_Y = 0.35
TITLE_H = 1.0
TITLE_W = SLIDE_W_IN - 2 * TITLE_X   # 12.133...
TITLE_SIZES = [36, 32, 28]   # 超宽降级（官方规范 36-44pt bold, v0.5 校准）

# 正文字号降级链（bullets/text）
BODY_SIZES = [18, 16, 14]

# 间距
COL_GAP = 0.3                # 列间距
BLOCK_GAP_V = 0.25           # 同列块间距
BOTTOM_PAD = 0.3             # bottom 区 = 内容实测高度 + 0.3"
BOTTOM_MAX_H = 1.2           # bottom 区最大高度
SAFE_W_RATIO = 0.92          # 文本可用宽度比例

IMAGE_FONT_PT = 14           # image 占位框标注字号（与契约示例一致）

# 字体缓存：避免重复加载 19MB ttc
_FONT_CACHE = {}


def _font(pt):
    key = (FONT_PATH, int(pt))  # v2.1: 键含路径——set_font 切换后缓存自然分桶, 不串字体
    f = _FONT_CACHE.get(key)
    if f is None:
        f = ImageFont.truetype(FONT_PATH, int(pt))
        _FONT_CACHE[key] = f
    return f


# v2.1: bullet 符号按当前字体字形实测选择——U+2022 "•" 不在 GB 字库(楷体/宋体渲成豆腐,
# 0717 楷体接线实拍)。判据: 与必然缺字形的私有区码点渲染 mask 逐字节相同=豆腐。
BULLET_CHAR = "\u2022"


def _refresh_bullet():
    global BULLET_CHAR
    try:
        f = _font(18)
        ref = bytes(f.getmask("\ue4c7"))  # 私有使用区=必然 .notdef, 作豆腐参照
        for c in ("\u2022", "\u25cf", "\u00b7"):  # • → ● → · 逐级降
            if bytes(f.getmask(c)) != ref:
                BULLET_CHAR = c
                return
    except Exception:
        pass
    BULLET_CHAR = "-"  # 全缺/检测失败=ASCII 兜底, 任何字体都有


_refresh_bullet()


def _text_w_in(text, pt):
    """实测字符串宽度（英寸）。1pt=1px，英寸=px/72。"""
    if not text:
        return 0.0
    return _font(pt).getlength(text) / 72.0


def line_height_in(pt):
    """行高（英寸）= font_pt * 1.35 / 72。"""
    return pt * 1.35 / 72.0


# 断行 token：拉丁字母/数字连续串按整词断（不拆 "layout"→"la/yout"），
# 其余（CJK/标点/空格）逐字符。整词超行宽时退化为逐字符拆该词。
_TOKEN_RE = re.compile(r"[A-Za-z0-9]+|.")

# v0.5 避头尾(视觉QA): 闭合标点禁做行首, 超宽也挂行尾(SAFE_W_RATIO 的 8% 余量兜住)
_NO_LINE_START = set("。，、；：！？）》」』】”’…%")


def _wrap_tokens(text, pt, avail, first_prefix="", cont_prefix=""):
    """
    通用断行核心：混合 token 累积宽度断行。
    first_prefix/cont_prefix：首行/续行前缀（bullet 悬挂缩进用），前缀占宽。
    返回行列表（含前缀）。
    """
    out = []
    for para in text.split("\n"):
        cur = first_prefix if not out else cont_prefix
        cur_w = _text_w_in(cur, pt)
        base = cur  # 当前行的纯前缀（判断"行还空着"用）
        if para == "":
            out.append(cur if cur.strip() else "")
            continue
        for tok in _TOKEN_RE.findall(para):
            tw = _text_w_in(tok, pt)
            if cur != base and cur_w + tw > avail and tok not in _NO_LINE_START:
                # 换行；行首丢弃纯空格 token
                out.append(cur)
                cur, cur_w, base = cont_prefix, _text_w_in(cont_prefix, pt), cont_prefix
                if tok == " ":
                    continue
            if cur == base and cur_w + tw > avail and len(tok) > 1:
                # 整词独占仍超宽：退化逐字符拆这个词
                for ch in tok:
                    cw = _text_w_in(ch, pt)
                    if cur != base and cur_w + cw > avail:
                        out.append(cur)
                        cur, cur_w, base = cont_prefix, _text_w_in(cont_prefix, pt), cont_prefix
                    cur += ch
                    cur_w += cw
            else:
                cur += tok
                cur_w += tw
        out.append(cur)
    return out if out else [""]


def wrap_text(text, pt, box_w_in):
    """
    混合断行（CJK逐字+拉丁按词）。返回行列表。
    可用宽度 = box_w_in * 0.92。空串返回 ['']（占一行高）。
    显式 \n 强制断行。
    """
    return _wrap_tokens(text, pt, box_w_in * SAFE_W_RATIO)


def wrap_bullet(item, pt, box_w_in):
    """
    单条 bullet 换行：首行前缀 BULLET_CHAR+空格（符号随字体字形能力选, v2.1），
    续行两空格缩进（悬挂缩进，前缀占宽）。
    """
    return _wrap_tokens(item, pt, box_w_in * SAFE_W_RATIO,
                        first_prefix=BULLET_CHAR + " ", cont_prefix="  ")


_EMPH_RE = re.compile(r"\*\*(.+?)\*\*")
# emoji 剔除域单源在 spec_norm(v2.6 拆分); 此处兜底剥除覆盖未走 normalize 的直调路径
_EMOJI_RE = spec_norm._EMOJI_RE


def _extract_emphasis(text):
    """v1.0 行内关键词强调(标杆课件模式): "**词**" → 剥标记, 返回(纯文本, 关键词列表)。
    v2.6: 全文本域统一入口——bullets/text 之外, 标题/表格/stat/图注/封面/divider/diagram
    也都走这里剥标记（此前非 bullets/text 域的 ** 字面星号直接渲染进成品, 0717 截图确诊）。"""
    text = _EMOJI_RE.sub("", text)
    words = _EMPH_RE.findall(text)
    return _EMPH_RE.sub(lambda m: m.group(1), text), words


def _fit_body(block, box_w_in, box_h_in):
    """
    对 bullets/text 块做字号降级适配。
    返回 (font_pt, lines, overflow, needed_h)。
    18->16->14，逐级尝试；14 仍超高 -> overflow=True（返回 14pt 的行）。
    """
    kind = block.get("kind")
    last_pt = BODY_SIZES[-1]
    last_lines = []
    last_needed = 0.0

    accents = []
    for pt in BODY_SIZES:
        if kind == "bullets":
            lines = []
            accents = []
            for item in block.get("items", []):
                raw = str(item)
                indent2 = raw.startswith("  ") or raw.startswith("　")  # v1.0 二级
                clean, words = _extract_emphasis(raw.strip())
                accents.extend(words)
                if indent2:
                    lines.extend(_wrap_tokens(clean, pt, box_w_in * SAFE_W_RATIO,
                                              first_prefix="   ◦ ", cont_prefix="     "))
                else:
                    lines.extend(wrap_bullet(clean, pt, box_w_in))
        else:  # text
            clean, accents = _extract_emphasis(str(block.get("text", "")))
            lines = wrap_text(clean, pt, box_w_in)

        needed_h = len(lines) * line_height_in(pt)
        last_pt, last_lines, last_needed = pt, lines, needed_h
        if needed_h <= box_h_in:
            return pt, lines, False, needed_h, accents

    # 所有字号都放不下：用最小字号，标 overflow
    return last_pt, last_lines, True, last_needed, accents


def _fit_title(title, box_w_in, box_h_in):
    """标题字号降级 36->32->28，实测换行。v2.6: 先剥 **标记并回传强调词。
    返回 (font_pt, lines, overflow, accents)。"""
    title, accents = _extract_emphasis(str(title))
    last_pt = TITLE_SIZES[-1]
    last_lines = [title]
    for pt in TITLE_SIZES:
        lines = wrap_text(title, pt, box_w_in)
        needed_h = len(lines) * line_height_in(pt)
        last_pt, last_lines = pt, lines
        if len(lines) == 1 and needed_h <= box_h_in:
            return pt, lines, False, accents
    needed_h = len(last_lines) * line_height_in(last_pt)
    return last_pt, last_lines, needed_h > box_h_in, accents


def _region_of(block):
    r = block.get("region", "center")
    if r not in ("left", "center", "right", "top", "bottom", "full"):
        r = "center"
    return r


# ---- v1.7 算法容错: spec 归一——v2.6 拆至 spec_norm.py（调用点单源 pipeline.run 不变;
# 回绑保持 solver.normalize_spec 消费面, 防下游 import 断链）----
KIND_ALIASES = spec_norm.KIND_ALIASES
REGION_ALIASES = spec_norm.REGION_ALIASES
VALID_REGIONS = spec_norm.VALID_REGIONS
_strip_emoji = spec_norm._strip_emoji
_strip_emoji_fields = spec_norm._strip_emoji_fields
normalize_spec = spec_norm.normalize_spec


def _weight(block):
    try:
        w = float(block.get("weight", 1))
        return w if w > 0 else 1.0
    except (TypeError, ValueError):
        return 1.0


def _image_box(block, x, y, w, h):
    return {
        "id": block.get("id"),
        "kind": "image",
        "x": round(x, 3), "y": round(y, 3),
        "w": round(w, 3), "h": round(h, 3),
        "font_pt": IMAGE_FONT_PT,
        # v2.6: placeholder 剥 **标记（占位标注域曾漏剥, 字面星号入图）
        "lines": ["[图: %s]" % _extract_emphasis(str(block.get("placeholder", "")))[0]],
        "overflow": False,
        # v0.1: 真图路径（solve() 已解析为绝对路径且存在，否则 None → 渲染器走占位框）
        "src": block.get("_src_abs"),
    }


def _body_box(block, x, y, w, h):
    """bullets/text 块：适配字号+换行，返回 (box, signal_or_None)。"""
    pt, lines, overflow, needed_h, accents = _fit_body(block, w, h)
    box = {
        "id": block.get("id"),
        "kind": block.get("kind"),
        "x": round(x, 3), "y": round(y, 3),
        "w": round(w, 3), "h": round(h, 3),
        "font_pt": pt,
        "lines": lines,
        "overflow": overflow,
        "accents": accents,  # v1.0 行内强调词(渲染器染accent色)
    }
    sig = None
    if overflow:
        sig = {
            "block_id": block.get("id"),
            "type": "overflow",
            "needed_h": round(needed_h, 3),
            "avail_h": round(h, 3),
            "suggestion": "reduce_items" if block.get("kind") == "bullets" else "split_slide",
        }
    return box, sig


def _chart_box(block, x, y, w, h):
    """v0.2: chart 与 image 同法占格子，数据原样透传给渲染器。"""
    return {
        "id": block.get("id"),
        "kind": "chart",
        "x": round(x, 3), "y": round(y, 3),
        "w": round(w, 3), "h": round(h, 3),
        "font_pt": IMAGE_FONT_PT,
        # v2.6: 图表标题/图注剥 **标记（此前漏剥, 字面星号进 chart 标题与 caption）
        "lines": ["[图表: %s]" % _extract_emphasis(str(block.get("title", "")))[0]],
        "overflow": False,
        "chart_type": block.get("chart_type", "bar"),
        "caption": _extract_emphasis(str(block.get("caption", "")))[0],
        "title": _extract_emphasis(str(block.get("title", "")))[0],
        "categories": block.get("categories", []),
        "series": block.get("series", []),
        # v2.5 参数图（流程图"互动-参数-美化-函数"）: 透传标记, pipeline 额外产互动 HTML 附件
        # 值容错: AI 常给字符串 "true"/"false"——bool("false")=True 陷阱, 按字面判
        "interactive": (block.get("interactive") is True
                        or str(block.get("interactive")).strip().lower() in ("true", "1", "yes")),
    }


# ---- table/stat/diagram 复合块求解: v2.6 拆至 solver_blocks.py（大文件拆分, 度量函数经
# import solver 运行时 live 引用——set_font/set_canvas 后不串快照）。此处回绑保持
# solver.* 消费面不变（solve_slide 底带预测量 / pipeline / 自测都从 solver 取）。----
import solver_blocks
STAT_SIZES = solver_blocks.STAT_SIZES
STAT_LABEL_PT = solver_blocks.STAT_LABEL_PT
TABLE_SIZES = solver_blocks.TABLE_SIZES
_stat_height_in = solver_blocks._stat_height_in
_stat_label_lines = solver_blocks._stat_label_lines
_stat_box = solver_blocks._stat_box
_table_needed_h = solver_blocks._table_needed_h
_table_box = solver_blocks._table_box
_diagram_box = solver_blocks._diagram_box
_widget_box = solver_blocks._widget_box


def _make_box(block, x, y, w, h):
    """按 kind 分派。返回 (box, signal_or_None)。"""
    kind = block.get("kind")
    if kind == "image":
        return _image_box(block, x, y, w, h), None
    if kind == "chart":
        return _chart_box(block, x, y, w, h), None
    if kind == "stat":
        return _stat_box(block, x, y, w, h)
    if kind == "table":
        return _table_box(block, x, y, w, h)
    if kind == "diagram":
        # v2.6: 原生可编辑流程图（节点+边 → pptx 形状/连接线, 替代 svg 自绘位图）
        return _diagram_box(block, x, y, w, h)
    if kind == "widget":
        # v3 阶段2: 小配件组件（badge/progress/rating, 原生形状+文字）
        return _widget_box(block, x, y, w, h)
    box, sig = _body_box(block, x, y, w, h)
    if kind not in ("bullets", "text"):
        # 拼错的 kind 禁静默吞: 按 text 尽力渲染 + 发可见诊断信号(比该块的溢出更根本)
        sig = {"block_id": block.get("id"), "type": "unknown_kind",
               "kind": kind, "detail": "未知kind, 已按text渲染, 请检查拼写"}
    return box, sig


def _stack_column(blocks, x, y_top, col_w, col_h):
    """
    同列多块：纵向按 weight 分高，块间距 BLOCK_GAP_V（契约规则5）。
    v0.5 QA修正: 文本类(bullets/text)的框高收缩为内容实测高, 整列垂直居中——
    治"内容顶着排导致下半页大片空白"的头重脚轻(视觉QA P1)。
    图类(image/chart/stat)保持分配高不缩。
    返回 (boxes, signals)。
    """
    boxes, signals = [], []
    n = len(blocks)
    if n == 0:
        return boxes, signals
    total_w = sum(_weight(b) for b in blocks)
    gaps = BLOCK_GAP_V * (n - 1)
    usable_h = max(0.1, col_h - gaps)

    # 第一遍: 各块分配高 + 文本类实测内容高(收缩)
    heights = []
    for b in blocks:
        alloc = usable_h * (_weight(b) / total_w)
        if b.get("kind") in ("bullets", "text"):
            _pt, lines, _of, needed, _acc = _fit_body(b, col_w, alloc)
            heights.append(min(alloc, needed + 0.15) if needed <= alloc else alloc)
        elif b.get("kind") == "table":
            # v1.5: 表格同文本类收缩为内容实测高（短表不占满整列留大片空白）
            needed = _table_needed_h(b, col_w)
            heights.append(min(alloc, needed + 0.1) if needed <= alloc else alloc)
        elif b.get("kind") == "stat":
            # v1.6: stat 同收缩——按最大字号+真实 label 行数的实测高封顶
            # （原 else 分支保持分配高: stat 两行内容拿满 weight 高=卡片大半页空白, 0717 实拍确诊）
            needed = _stat_height_in(STAT_SIZES[0], len(_stat_label_lines(b, col_w))) + 0.3
            heights.append(min(alloc, needed))
        else:
            heights.append(alloc)
    content_h = sum(heights) + gaps
    # v3.2 方位优化: 剩余空间按 1/3 上偏（optical center 排版惯例——纯几何居中
    # 在标题带下头重脚轻, 视觉重心略偏上更稳; 0717 内容页实拍标题下大顶空确诊）
    cy = y_top + max(0.0, (col_h - content_h) * 0.33)

    for b, bh in zip(blocks, heights):
        box, sig = _make_box(b, x, cy, col_w, bh)
        boxes.append(box)
        if sig:
            signals.append(sig)
        cy += bh + BLOCK_GAP_V
    return boxes, signals


def _solve_cover(slide, slide_id, meta_title):
    """
    v0.3 cover 页型：忽略 blocks 常规布局。
    渲染器不支持文本居中对齐 → 用实测文本宽收窄 box 并让 box 自身几何居中，零渲染器改动。
    """
    boxes = []
    # v2.6: 封面主/副标题剥 **标记（封面域曾漏剥）; 强调词回填 box accents
    main, m_acc = _extract_emphasis(str(meta_title or slide.get("title", "")))
    pt = 44
    while pt > 24 and _text_w_in(main, pt) > SLIDE_W_IN - 2.0:
        pt -= 4  # 超宽降级 44→40→36→...
    # v1.7: 24pt 仍超宽 → wrap_text 断行多行（此前单行 overflow 恒 False 静默画出画布）
    m_lines = ([main] if _text_w_in(main, pt) <= SLIDE_W_IN - 2.0
               else wrap_text(main, pt, SLIDE_W_IN - 1.2))
    m_h = len(m_lines) * line_height_in(pt) + 0.2
    w = min(SLIDE_W_IN - 1.2,
            max(_text_w_in(l, pt) for l in m_lines) / SAFE_W_RATIO + 0.4)
    boxes.append({
        "id": "%s_title" % slide_id, "kind": "title",
        "x": round((SLIDE_W_IN - w) / 2, 3), "y": round(SLIDE_H_IN * 0.40 - m_h / 2, 3),
        "w": round(w, 3), "h": round(m_h, 3),
        "font_pt": pt, "lines": m_lines, "overflow": False,
        "accents": m_acc,
    })
    sub, s_acc = _extract_emphasis(str(slide.get("title", "") if meta_title else ""))
    if sub and sub != main:
        s_lines = ([sub] if _text_w_in(sub, 20) <= SLIDE_W_IN - 2.0
                   else wrap_text(sub, 20, SLIDE_W_IN - 1.2))
        sw = min(SLIDE_W_IN - 1.2,
                 max(_text_w_in(l, 20) for l in s_lines) / SAFE_W_RATIO + 0.3)
        boxes.append({
            "id": "%s_subtitle" % slide_id, "kind": "text",
            "x": round((SLIDE_W_IN - sw) / 2, 3),
            "y": round(boxes[0]["y"] + boxes[0]["h"] + 0.3, 3),
            "w": round(sw, 3), "h": round(len(s_lines) * line_height_in(20) + 0.15, 3),
            "font_pt": 20, "lines": s_lines, "overflow": False,
            "accents": s_acc,
        })
    return {"id": slide_id, "type": "cover", "boxes": boxes, "signals": []}


def _solve_divider(slide, slide_id):
    """v1.3 章节分隔页: 大编号+章节名, 几何居中(同cover手法)。底饰由渲染端按divider_style画。"""
    # v2.6: 剥 **标记（divider 反白字无 accent 概念, 只清残留符号）
    num = _extract_emphasis(str(slide.get("number", "")))[0]
    name = _extract_emphasis(str(slide.get("title", "")))[0]
    boxes = []
    npt, tpt = 96, 34
    if num:
        nw = min(SLIDE_W_IN - 1.2, _text_w_in(num, npt) / SAFE_W_RATIO + 0.4)
        boxes.append({"id": "%s_num" % slide_id, "kind": "divider_num",
                      "x": round((SLIDE_W_IN - nw) / 2, 3),
                      "y": round(SLIDE_H_IN * 0.34 - line_height_in(npt) / 2, 3),
                      "w": round(nw, 3), "h": round(line_height_in(npt) + 0.2, 3),
                      "font_pt": npt, "lines": [num], "overflow": False})
    if name:
        # v1.7: 超宽章节名断行多行（此前单行静默溢出）
        t_lines = ([name] if _text_w_in(name, tpt) <= SLIDE_W_IN - 2.0
                   else wrap_text(name, tpt, SLIDE_W_IN - 1.2))
        tw = min(SLIDE_W_IN - 1.2,
                 max(_text_w_in(l, tpt) for l in t_lines) / SAFE_W_RATIO + 0.4)
        ty = (boxes[0]["y"] + boxes[0]["h"] + 0.25) if boxes else SLIDE_H_IN * 0.42
        boxes.append({"id": "%s_title" % slide_id, "kind": "divider_title",
                      "x": round((SLIDE_W_IN - tw) / 2, 3), "y": round(ty, 3),
                      "w": round(tw, 3), "h": round(len(t_lines) * line_height_in(tpt) + 0.15, 3),
                      "font_pt": tpt, "lines": t_lines, "overflow": False})
    return {"id": slide_id, "type": "divider", "boxes": boxes, "signals": []}


def solve_slide(slide, meta_title=""):
    """单页求解：返回 {id, boxes, signals}。"""
    boxes, signals = [], []
    slide_id = slide.get("id", "s")

    if slide.get("type") == "cover":
        return _solve_cover(slide, slide_id, meta_title)
    if slide.get("type") == "divider":
        return _solve_divider(slide, slide_id)
    if slide.get("type") == "hero":
        # v3 强设计页型: 文字语义块+deco 装饰
        return solver_blocks.solve_hero(slide, slide_id)
    if slide.get("type") == "quote":
        return solver_blocks.solve_quote(slide, slide_id)

    # --- 1. 标题带 ---（v3: full_bleed 自由页语义已随整页截图路线废除, 恒产标题框）
    title = slide.get("title", "")
    if True:
        t_pt, t_lines, t_overflow, t_acc = _fit_title(title, TITLE_W, TITLE_H)
        boxes.append({
            "id": "%s_title" % slide_id,
            "kind": "title",
            "x": TITLE_X, "y": TITLE_Y, "w": round(TITLE_W, 3), "h": TITLE_H,
            "font_pt": t_pt,
            "lines": t_lines,
            "overflow": t_overflow,
            "accents": t_acc,  # v2.6: 标题 **词** → 渲染端 accent 色
        })

    # 分区收集
    blocks = slide.get("blocks", [])
    by_region = {"top": [], "left": [], "center": [], "right": [], "bottom": [], "full": []}
    for b in blocks:
        by_region[_region_of(b)].append(b)

    content_x = TITLE_X
    content_w = SLIDE_W_IN - 2 * TITLE_X       # 中部/顶/底可用宽
    mid_top = TITLE_Y + TITLE_H + 0.2          # 标题带下方留 0.2" 起中部/top

    # --- 2. bottom 区（贴底，高度=实测内容高+0.3，最大1.2）---
    #    需先预测量以确定中部下边界。bottom 内多块横向按 weight 分宽。
    bottom_blocks = by_region["bottom"]
    bottom_h = 0.0
    bottom_layout = []  # (block, x, w) 预排，稍后定 y
    if bottom_blocks:
        total_w = sum(_weight(b) for b in bottom_blocks)
        n = len(bottom_blocks)
        gaps = COL_GAP * (n - 1)
        usable_w = content_w - gaps
        bx = content_x
        max_needed = 0.0
        for b in bottom_blocks:
            bw = usable_w * (_weight(b) / total_w)
            bottom_layout.append((b, bx, bw))
            # 预测该块用 18pt 时的内容高（bottom 不做字号降级探测下限，取实测）
            if b.get("kind") == "stat":
                # v0.7: stat 真算高度(最小字号可放下的高度), 别当 0.6" 薄物预测
                # v1.6: 高度含真实 label 行数(按该块实际列宽断行)
                needed = _stat_height_in(STAT_SIZES[-1], len(_stat_label_lines(b, bw)))
            elif b.get("kind") == "table":
                # v1.5: 最小字号实测高(bottom 带最大 1.2", 表格放这里大概率溢出→有信号)
                needed = _table_needed_h(b, bw, pt=TABLE_SIZES[-1])
            elif b.get("kind") in ("image", "chart", "diagram"):
                needed = 0.6
            else:
                # 用最大字号实测，代表最坏内容高
                _pt, lines, _of, nh, _acc = _fit_body(b, bw, 999.0)
                needed = nh
            max_needed = max(max_needed, needed)
            bx += bw + COL_GAP
        bottom_h = min(BOTTOM_MAX_H, max_needed + BOTTOM_PAD)

    # v3.2 方位修正: 底带上提为页脚区让位 0.45"（原 0.15" 时 bottom 内容压页脚, widget 页实拍）
    bottom_y = SLIDE_H_IN - bottom_h - 0.45 if bottom_blocks else SLIDE_H_IN
    if bottom_blocks:
        for (b, bx, bw) in bottom_layout:
            box, sig = _make_box(b, bx, bottom_y, bw, bottom_h)
            boxes.append(box)
            if sig:
                signals.append(sig)

    # --- 3. top 区（紧跟标题带下方）---
    top_blocks = by_region["top"]
    mid_start = mid_top
    if top_blocks:
        top_h = 1.2  # top 带固定高度（紧跟标题下方的一条带）
        tb, ts = _stack_column_horizontal(top_blocks, content_x, mid_top, content_w, top_h)
        boxes.extend(tb)
        signals.extend(ts)
        mid_start = mid_top + top_h + BLOCK_GAP_V

    # --- 中部可用高度：mid_start 到 bottom 之上 ---
    mid_bottom = (bottom_y - BLOCK_GAP_V) if bottom_blocks else (SLIDE_H_IN - 0.3)
    mid_h = max(0.5, mid_bottom - mid_start)

    # --- 6. full 占中部整宽 ---
    # v1.1修: full 与 left/center/right 同页共存时不再静默丢弃列(内容丢失且零信号的实拍bug)——
    # full 按内容实测高排上部, 剩余中部高度给列; full 独占时行为不变
    full_blocks = by_region["full"]
    cols = [("left", by_region["left"]),
            ("center", by_region["center"]),
            ("right", by_region["right"])]
    has_cols = any(blks for _n, blks in cols)
    if full_blocks:
        full_h = mid_h
        if has_cols:
            # full 收缩为内容高(文本类实测; 图类取mid_h的45%), 给列留空间
            need = 0.0
            for b in full_blocks:
                if b.get("kind") in ("bullets", "text"):
                    _p, _l, _o, nh, _a = _fit_body(b, content_w, mid_h)
                    need += nh + 0.15
                elif b.get("kind") == "table":
                    need += _table_needed_h(b, content_w) + 0.1  # v1.5 表格实测高
                else:
                    need += mid_h * 0.45
            need += BLOCK_GAP_V * (len(full_blocks) - 1)
            full_h = min(need, mid_h * 0.55)
        fb, fs = _stack_column(full_blocks, content_x, mid_start, content_w, full_h)
        boxes.extend(fb)
        signals.extend(fs)
        if has_cols:
            mid_start = mid_start + full_h + BLOCK_GAP_V
            mid_h = max(0.5, mid_bottom - mid_start)
    if has_cols:
        # --- 4/5. left/center/right 横向分中部宽 ---
        active = [(name, blks) for name, blks in cols if blks]
        if active:
            total_col_w = sum(sum(_weight(b) for b in blks) for _n, blks in active)
            n = len(active)
            gaps = COL_GAP * (n - 1)
            usable_w = content_w - gaps
            cx = content_x
            for _name, blks in active:
                col_weight = sum(_weight(b) for b in blks)
                col_w = usable_w * (col_weight / total_col_w)
                cb, cs = _stack_column(blks, cx, mid_start, col_w, mid_h)
                boxes.extend(cb)
                signals.extend(cs)
                cx += col_w + COL_GAP

    return {"id": slide_id, "boxes": boxes, "signals": signals}


def _stack_column_horizontal(blocks, x, y_top, band_w, band_h):
    """
    横向排（用于 top/bottom 带内多块）：按 weight 分宽，列间距 COL_GAP。
    返回 (boxes, signals)。
    """
    boxes, signals = [], []
    n = len(blocks)
    if n == 0:
        return boxes, signals
    total_w = sum(_weight(b) for b in blocks)
    gaps = COL_GAP * (n - 1)
    usable_w = max(0.1, band_w - gaps)
    cx = x
    for b in blocks:
        bw = usable_w * (_weight(b) / total_w)
        box, sig = _make_box(b, cx, y_top, bw, band_h)
        boxes.append(box)
        if sig:
            signals.append(sig)
        cx += bw + COL_GAP
    return boxes, signals


def solve(spec, base_dir=None):
    """
    入口：spec.json 结构 -> layout.json 结构（全按契约）。
    base_dir: spec 文件所在目录，用于解析 image block 的相对 src（v0.1）。
    """
    import os
    # v0.1: image src 解析——相对路径以 base_dir 为基准；文件不存在 → None（渲染器走占位框）
    for s in spec.get("slides", []):
        for b in s.get("blocks", []):
            if b.get("kind") == "image" and b.get("src"):
                p = str(b["src"])
                if not os.path.isabs(p) and base_dir:
                    p = os.path.join(base_dir, p)
                b["_src_abs"] = os.path.normpath(p) if os.path.isfile(p) else None

    meta = spec.get("meta", {})

    def _abs_img(p):
        if not p or p == "none":
            return None
        p = str(p)
        if not os.path.isabs(p) and base_dir:
            p = os.path.join(base_dir, p)
        return os.path.normpath(p) if os.path.isfile(p) else None

    # v2.2: 画布切换（必须最先——TITLE_W 等派生几何被所有 solve_slide 消费）
    _canvas_sig = set_canvas(meta.get("canvas"))
    # v2.1: meta.font 接线——度量与 pptx 名同步切换（必须在任何 solve_slide 度量之前）
    _font_sig = set_font(meta.get("font"))
    layout = {
        "slide_w_in": SLIDE_W_IN,
        "slide_h_in": SLIDE_H_IN,
        "font": FONT_NAME,
        # v2.6: 页脚/渲染端消费纯文本——剥 **标记（cover 主标题强调词在 _solve_cover 内提取）
        "meta_title": _extract_emphasis(str(meta.get("title", "")))[0],
        # v1.3: 风格包(完整视觉语言)优先, 兜底 v0.5 四色预设; 渲染器单源读此处
        "theme": (style_packs.resolve_style(meta.get("theme"))
                  or themes.resolve_theme(meta.get("theme"))),
        "bg_image": _abs_img(meta.get("bg_image")),        # v0.6: 全deck默认背景
        "slides": [],
    }
    # v1.7 逐页故障隔离: 单页求解异常 → 该页出错误占位页+solve_errors 信号, 不炸全 deck
    # （原先一页坏数据 raise 直接全 deck 零产出; 信号经 pipeline 汇总回喂, AI 只需重修该页）
    solve_errors = []
    if _canvas_sig:
        solve_errors.append(_canvas_sig)
    if _font_sig:
        solve_errors.append(_font_sig)
    for s in spec.get("slides", []):
        try:
            layout["slides"].append(solve_slide(s, meta_title=meta.get("title", "")))
        except Exception as e:
            sid = (s.get("id") if isinstance(s, dict) else None) or "s%d" % len(layout["slides"])
            solve_errors.append({"type": "slide_error", "slide": sid, "detail": str(e)[:160]})
            layout["slides"].append({"id": sid, "boxes": [{
                "id": "%s_err" % sid, "kind": "text",
                "x": TITLE_X, "y": 2.8, "w": TITLE_W, "h": 1.8, "font_pt": 16,
                # 占位页只报事实(结构标注); "怎么修"的引导是提示词/信号回喂的职责(slide_error signal)
                "lines": ["[!] slide error: %s" % sid,
                          str(e)[:110]],
                "overflow": False}], "signals": []})
    layout["solve_errors"] = solve_errors
    # v0.6: 页级背景覆盖（"none"=显式关; 缺省 None=继承顶层）
    for s_spec, s_lay in zip(spec.get("slides", []), layout["slides"]):
        raw = s_spec.get("bg_image")
        s_lay["bg_image"] = "none" if raw == "none" else _abs_img(raw)
        # v3: deco 装饰组件透传（类型/色值域归一在 spec_norm; v3.2 锚定解析+钳几何——
        # anchor="块id" 相对语义块落定, 文字增多块变高装饰自动跟随）
        if s_spec.get("deco"):
            s_lay["deco"] = solver_blocks.clamp_deco(s_spec, s_lay)

    # v1.3: 运行时几何校验(凛倾"算法修正"闸完整化)——重叠/出界此前只在自测断言里,
    # 真跑时几何bug零信号。现在每次solve都校验, 异常发signal交上游, 不静默。
    for s_lay in layout["slides"]:
        bxs = s_lay["boxes"]
        for b in bxs:
            if (b["x"] < -1e-6 or b["y"] < -1e-6
                    or b["x"] + b["w"] > SLIDE_W_IN + 1e-3
                    or b["y"] + b["h"] > SLIDE_H_IN + 1e-3):
                s_lay["signals"].append({"block_id": b["id"], "type": "out_of_canvas",
                                         "detail": "x=%.2f y=%.2f w=%.2f h=%.2f" %
                                                   (b["x"], b["y"], b["w"], b["h"])})
        for i in range(len(bxs)):
            for j in range(i + 1, len(bxs)):
                a, c = bxs[i], bxs[j]
                ix = min(a["x"] + a["w"], c["x"] + c["w"]) - max(a["x"], c["x"])
                iy = min(a["y"] + a["h"], c["y"] + c["h"]) - max(a["y"], c["y"])
                if ix > 0.05 and iy > 0.05:  # >0.05"交叠才算(贴边容差)
                    s_lay["signals"].append({"block_id": a["id"], "type": "overlap",
                                             "with": c["id"],
                                             "detail": "%.2fx%.2f in" % (ix, iy)})
        # v3.2: 装饰盖字检测（实体 deco 与文字盒交叠 >40% 盒面积→警告; 小面积压角=设计手法不报）
        for d in (s_lay.get("deco") or []):
            t = d.get("type")
            if t == "circle" and isinstance(d.get("r"), (int, float)):
                dr = (d.get("x", 0) - d["r"], d.get("y", 0) - d["r"], d["r"] * 2, d["r"] * 2)
            elif t in ("rect", "art"):
                dr = (d.get("x", 0), d.get("y", 0), d.get("w", 0) or 0, d.get("h", 0) or 0)
            else:
                continue
            for b in bxs:
                if b.get("kind") in ("image", "chart"):
                    continue  # 图类被压属版面取舍, 文字可读性才是硬信号
                ix = min(dr[0] + dr[2], b["x"] + b["w"]) - max(dr[0], b["x"])
                iy = min(dr[1] + dr[3], b["y"] + b["h"]) - max(dr[1], b["y"])
                if ix > 0 and iy > 0 and ix * iy > 0.4 * b["w"] * b["h"]:
                    s_lay["signals"].append({"block_id": b["id"], "type": "deco_overlap",
                                             "detail": "%s 装饰盖住该文字块 %.0f%%, 挪装饰或加 anchor 跟随"
                                                       % (t, 100 * ix * iy / (b["w"] * b["h"]))})
                    break
    return layout


# ---------------------------------------------------------------------------
# 自测
# ---------------------------------------------------------------------------
def _rects_overlap(a, b):
    """两框是否重叠（面积交集 > 微小容差）。相邻贴边不算重叠。"""
    eps = 1e-3
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1, bx2, by2 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
    ix = min(ax2, bx2) - max(ax1, bx1)
    iy = min(ay2, by2) - max(ay1, by1)
    return ix > eps and iy > eps


if __name__ == "__main__":
    # 最小 spec：覆盖 bullets/text/image + left/right/bottom region
    # 其中一条 bullets 故意超长，触发字号降级失败 -> overflow。
    demo_spec = {
        "meta": {"title": "PPT ASCII 管线 v0 自测", "font": FONT_NAME},
        "slides": [
            {
                "id": "s1",
                "title": "确定性布局求解器自测页",
                "blocks": [
                    {
                        "id": "b1", "kind": "bullets", "region": "left", "weight": 2,
                        "items": [
                            "AI 只给语义拓扑，零坐标",
                            "算法用真实字体度量做几何求解与换行",
                            # 故意超长：多条长文本挤爆 left 列 -> 即便降到 14pt 也放不下 -> overflow
                            "这是一条被刻意写得非常非常长的要点，用来把左侧列的可用高度彻底撑爆，从而在字号从十八降到十六再降到十四之后依然放不下，进而触发溢出信号；我们需要验证求解器能在这种极端情况下正确地标记 overflow 为真并按契约格式产出对应的 signals 数组元素，一个字都不能少。",
                            "再补一条同样冗长啰嗦的要点继续叠加高度压力，确保十四号字也无法容纳，让溢出判定稳定为真而不是恰好卡在边界上产生抖动，务必写满到自动换成好几行为止。",
                            "第三条附加要点，进一步加码，把内容写得足够长以便占据更多行数从而稳定压垮布局的可用高度上限。",
                            "第四条附加要点，继续加码保证溢出，同样写得又臭又长塞满整整好几行绝不留白。",
                            "第五条要点，依旧冗长啰嗦不厌其烦地堆叠文字确保总高度远超容器高度。",
                            "第六条要点，收尾也要长，让十四号字号下的总行数彻底突破可用高度边界。",
                            "第七条要点补充。", "第八条要点补充。", "第九条要点补充。",
                            "第十条要点补充。", "第十一条要点补充。", "第十二条要点补充。",
                        ],
                    },
                    {
                        "id": "b2", "kind": "image", "region": "right", "weight": 1,
                        "placeholder": "系统架构图",
                    },
                    {
                        "id": "b3", "kind": "text", "region": "bottom", "weight": 1,
                        "text": "渲染器只消费 solver 算好的坐标与行数组，保证三端对齐。",
                    },
                ],
            }
        ],
    }

    result = solve(demo_spec)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    # --- 断言 ---
    slide = result["slides"][0]
    boxes = slide["boxes"]

    # 断言消息用 ASCII，避免 stderr 在 GBK 控制台乱码掩盖失败原因。
    # 1) 所有框在画布内
    for bx in boxes:
        assert bx["x"] >= -1e-6, "box out of left edge: %s" % bx["id"]
        assert bx["y"] >= -1e-6, "box out of top edge: %s" % bx["id"]
        assert bx["x"] + bx["w"] <= SLIDE_W_IN + 1e-3, "box out of right edge: %s (%.3f)" % (bx["id"], bx["x"] + bx["w"])
        assert bx["y"] + bx["h"] <= SLIDE_H_IN + 1e-3, "box out of bottom edge: %s (%.3f)" % (bx["id"], bx["y"] + bx["h"])

    # 2) 两两无重叠
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            assert not _rects_overlap(boxes[i], boxes[j]), \
                "box overlap: %s <-> %s" % (boxes[i]["id"], boxes[j]["id"])

    # 3) overflow 信号确实产生
    assert any(s["type"] == "overflow" for s in slide["signals"]), "no overflow signal produced"
    of_box = [b for b in boxes if b.get("overflow")]
    assert of_box, "no box marked overflow"

    print("\n=== SELF-TEST PASSED ===")
    print("boxes=%d, signals=%d, overflow_boxes=%s" % (
        len(boxes), len(slide["signals"]), [b["id"] for b in of_box]))
    print("signals=%s" % json.dumps(slide["signals"], ensure_ascii=False))
