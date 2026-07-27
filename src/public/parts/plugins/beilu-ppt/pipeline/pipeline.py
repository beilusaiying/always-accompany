# -*- coding: utf-8 -*-
"""
pipeline.py —— v0.2 管线编排（主AI负责）

线路(v3 场景链): spec.json → normalize → [回程闭环: solve → signals? → 降级策略改spec → 重solve]
      → compose 场景图(视觉决策单源) → pptx_paint/png_paint 双薄画笔 + ascii_view(layout 草稿)
      → signals 汇总(残余溢出 + 对比度警告 + scene/paint 错误)

回程闭环哲学(契约 v0.2): 几何归算法, 取舍归AI/人。
  - 确定性策略只做"语义无损可自动"的两种: reduce_items(砍尾条)/split_slide(对半拆页)
  - text 溢出、widen_region 不自动修——保留 signal 交上游, 诚实降级
  - resolve_fn 钩子: 接真 LLM 的位置, 传入则替代确定性策略
"""
import copy
import json
import sys
from pathlib import Path

import solver
import ascii_view
import compose
import png_paint
import pptx_paint

HERE = Path(__file__).parent

# ---------------- 对比度自检 (WCAG 2.x) ----------------

def _lum(hex6):
    """相对亮度。hex 无 #（契约）。"""
    def chan(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex6[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)


def _ratio(fg, bg):
    l1, l2 = sorted((_lum(fg), _lum(bg)), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)


def contrast_signals(theme):
    """theme 存在时核 body/bg(≥4.5) 与 title/bg(≥3.0)，不足发 warning（不阻断）。"""
    if not theme:
        return []
    bg = theme.get("bg_color", "FFFFFF")
    checks = [("body/bg", theme.get("body_color", "333333"), 4.5),
              ("title/bg", theme.get("title_color", "1F2937"), 3.0)]
    out = []
    for pair, fg, minimum in checks:
        try:
            r = _ratio(fg, bg)
        except (ValueError, IndexError):
            out.append({"type": "theme_error", "pair": pair, "detail": "非法hex(需6位无#)"})
            continue
        if r < minimum:
            out.append({"type": "contrast_warning", "pair": pair,
                        "ratio": round(r, 2), "min": minimum})
    return out


# ---------------- 回程闭环: 确定性降级策略 ----------------

def _find_block(spec, slide_id, block_id):
    for si, s in enumerate(spec.get("slides", [])):
        if s.get("id") == slide_id:
            for b in s.get("blocks", []):
                if b.get("id") == block_id:
                    return si, s, b
    return None, None, None


def _apply_default_strategy(spec, sig):
    """
    对单条 overflow 信号做语义无损的自动降级。原地改 spec。
    返回 action 描述字符串；None = 该信号无法自动修（留给上游）。
    """
    si, slide, block = _find_block(spec, sig.get("slide"), sig.get("block_id"))
    if block is None:
        return None
    if block.get("kind") == "text":
        return _split_text_block(spec, sig, si, slide, block)
    if block.get("kind") == "table":
        return _split_table_block(spec, sig, si, slide, block)
    if block.get("kind") != "bullets":
        return None  # 未知块: 不自动修, 诚实降级
    items = block.get("items", [])

    # 无损优先: 拆页(内容不丢)先于砍条(有损)。suggestion 仅供上游LLM参考, 确定性策略按可行性
    if len(items) >= 4:
        half = len(items) // 2
        rest = items[half:]
        block["items"] = items[:half]
        cont = copy.deepcopy(slide)
        cont["id"] = slide["id"] + "_cont"
        cont["title"] = (slide.get("title") or "") + "（续）"
        # 续页只保留被拆的块, 其余块留在原页
        cont["blocks"] = [b for b in cont["blocks"] if b.get("id") == block["id"]]
        cont["blocks"][0]["items"] = rest
        cont["blocks"][0]["region"] = "full"
        spec["slides"].insert(si + 1, cont)
        return "split_slide: %s 拆 %d+%d 条到续页" % (block["id"], half, len(rest))

    if len(items) > 2:
        moved = items.pop()
        # 已有续页(split产物)时尾条移进续页头部=完全无损; 无续页才真砍
        nxt = spec["slides"][si + 1] if si + 1 < len(spec["slides"]) else None
        if nxt and nxt.get("id") == (sig.get("slide") or "") + "_cont":
            for nb in nxt.get("blocks", []):
                if nb.get("id") == block["id"]:
                    nb.setdefault("items", []).insert(0, moved)
                    return "move_item: %s 尾条移入续页(原页剩%d)" % (block["id"], len(items))
        return "reduce_items: %s 砍尾条(剩%d): %.20s…" % (block["id"], len(items), moved)
    return None


def _split_table_block(spec, sig, si, slide, block):
    """
    v1.5: table 溢出的无损拆行——rows 对半拆到续页（表头复制，同 bullets 续页机制）。
    <2 行数据无法无损拆 → None 交上游。
    """
    rows = block.get("rows") or []
    if len(rows) < 2:
        return None
    half = len(rows) // 2 or 1
    rest = rows[half:]
    block["rows"] = rows[:half]
    nxt = spec["slides"][si + 1] if si + 1 < len(spec["slides"]) else None
    if nxt and nxt.get("id") == (sig.get("slide") or "") + "_cont":
        for nb in nxt.get("blocks", []):
            if nb.get("id") == block["id"]:
                nb["rows"] = rest + (nb.get("rows") or [])
                return "split_table: %s 后%d行并入续页" % (block["id"], len(rest))
    cont = copy.deepcopy(slide)
    cont["id"] = slide["id"] + "_cont"
    cont["title"] = (slide.get("title") or "") + "（续）"
    cont["blocks"] = [b for b in cont["blocks"] if b.get("id") == block["id"]]
    cont["blocks"][0]["rows"] = rest
    cont["blocks"][0]["region"] = "full"
    spec["slides"].insert(si + 1, cont)
    return "split_table: %s 拆 %d+%d 行到续页" % (block["id"], half, len(rest))


_SENT_END = "。；！？!?;"


def _split_text_block(spec, sig, si, slide, block):
    """
    v0.4: text 溢出的无损拆段——按句子边界对半拆到续页（与 bullets split 同款续页机制）。
    只有 >=2 句才可拆；单句超长无法无损拆 → None 交上游。
    """
    text = str(block.get("text", ""))
    sents, cur = [], ""
    for ch in text:
        cur += ch
        if ch in _SENT_END:
            sents.append(cur)
            cur = ""
    if cur.strip():
        sents.append(cur)
    if len(sents) < 2:
        return None  # 单句无损拆不了, 诚实降级

    half = len(sents) // 2 or 1
    block["text"] = "".join(sents[:half])
    rest = "".join(sents[half:])

    nxt = spec["slides"][si + 1] if si + 1 < len(spec["slides"]) else None
    if nxt and nxt.get("id") == (sig.get("slide") or "") + "_cont":
        # 已有续页: 后半段并入续页同 id 块头部
        for nb in nxt.get("blocks", []):
            if nb.get("id") == block["id"]:
                nb["text"] = rest + nb.get("text", "")
                return "split_text: %s 后%d句并入续页" % (block["id"], len(sents) - half)
    cont = copy.deepcopy(slide)
    cont["id"] = slide["id"] + "_cont"
    cont["title"] = (slide.get("title") or "") + "（续）"
    cont["blocks"] = [b for b in cont["blocks"] if b.get("id") == block["id"]]
    cont["blocks"][0]["text"] = rest
    cont["blocks"][0]["region"] = "full"
    spec["slides"].insert(si + 1, cont)
    return "split_text: %s 拆 %d+%d 句到续页" % (block["id"], half, len(sents) - half)


def _collect_signals(layout):
    out = []
    for s in layout["slides"]:
        for sig in s.get("signals", []):
            out.append({"slide": s["id"], **sig})
    return out


# ---------------- v3.1 deco art 小图组件（凛倾 0717: 前端代码只用于美化小组件转小图, 整页转换不做） ----------------

MAX_DECO_ART_PER_DECK = 12  # 单 deck art 小图渲染上限（Chrome ~2s/张）


def _resolve_deco_art(layout, out_dir):
    """
    deco type="art": AI 前端代码（svg/div 小组件）→ Chrome 透明底截小图 → src →
    compose 以 image 原语放装饰层。文字禁进 art（装饰是图, 正文永远语义块）。
    失败/超限 → 该装饰缺省不画（装饰非内容, 不阻断）+ resolve_log 可见。
    """
    import os
    import asset_lib
    sigs = []
    made = 0
    for sl in layout.get("slides", []):
        for i, d in enumerate(sl.get("deco") or []):
            if d.get("type") != "art" or not d.get("html"):
                continue
            if made >= MAX_DECO_ART_PER_DECK:
                sigs.append({"type": "deco_art_skip", "slide": sl.get("id"),
                             "detail": "超过单 deck art 小图上限 %d" % MAX_DECO_ART_PER_DECK})
                continue
            made += 1
            w_px = max(16, round(float(d.get("w", 2.0)) * 96))
            h_px = max(16, round(float(d.get("h", 2.0)) * 96))
            out_png = os.path.join(str(out_dir), "art_%s_%d.png" % (sl.get("id"), i))
            hit = None
            try:
                hit = asset_lib.render_markup_png(d["html"], out_png, w=w_px, h=h_px,
                                                  transparent=True)
            except Exception as e:
                sigs.append({"type": "deco_art_error", "slide": sl.get("id"),
                             "detail": str(e)[:100]})
                continue
            if hit:
                d["src"] = os.path.abspath(hit)
            else:
                sigs.append({"type": "deco_art_miss", "slide": sl.get("id"),
                             "detail": "art 小图渲染失败/无Chrome, 该装饰缺省"})
    return sigs


# ---------------- v1.5 主链路素材解析（确定性, 零 LLM） ----------------

MAX_ASSETS_PER_DECK = 4  # 单 deck 素材解析上限（Chrome 截图 ~3s/张 + Commons 网络, 防拖爆超时）


def _download_image(url, out_base, timeout=20, max_mb=15):
    """
    v1.7 配图容错: image src 支持 http(s) URL——限时限量下载转本地。
    任何失败(超时/死链/非图片/超限)返回 None → 调用方占位框, 离线不阻断（核心不死依赖网络）。
    UA 必带（裸 urllib 无 UA 被 WAF 403, 本机环境实证）。svg 下载件经 Chrome 通路转位图
    （渲染端只吃位图）; webp 等 python-pptx 不认的格式拒收判 miss。
    """
    import os
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 pptx-pipeline/1.7"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ct = (r.headers.get("Content-Type") or "").lower().split(";")[0].strip()
            ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
                   "image/gif": ".gif", "image/svg+xml": ".svg"}.get(ct)
            if not ext:
                low = url.split("?")[0].lower()
                for e2 in (".png", ".jpg", ".jpeg", ".gif", ".svg"):
                    if low.endswith(e2):
                        ext = ".jpg" if e2 == ".jpeg" else e2
                        break
            if not ext:
                return None
            data = r.read(max_mb * 1024 * 1024 + 1)
        if len(data) > max_mb * 1024 * 1024 or len(data) < 1024:
            return None
        if ext == ".svg":
            import asset_lib
            return asset_lib.render_markup_png(data.decode("utf-8", "replace"), out_base + ".png")
        outp = out_base + ext
        with open(outp, "wb") as f:
            f.write(data)
        return os.path.abspath(outp)
    except Exception:
        return None


def _check_markup_png(path, expect_w=None, expect_h=None):
    """
    v2.1 渲染准度校验（流程图③"算法优化画面渲染和准度"）: 对 AI 代码的 Chrome 渲染产物做
    确定性体检, 返回问题描述列表（空=通过）。覆盖: 尺寸偏差 / 四边贴死像素(内容被裁嫌疑)。
    只产信号不拦产物——判读与修改是 AI 的职责（信号回喂自纠）。
    """
    probs = []
    try:
        from PIL import Image
        with Image.open(path) as im:
            w, h = im.size
            rgb = im.convert("RGB")
            if expect_w and expect_h and (abs(w - expect_w) > 4 or abs(h - expect_h) > 4):
                probs.append("尺寸 %dx%d 偏离预期 %dx%d" % (w, h, expect_w, expect_h))
            # 贴边裁切检测: 边线像素方差——纯色边(背景/整边框)=低方差正常;
            # 文字/图形跨出边界被裁=边线高方差。角点参照法会被设计性边框骗(实测), 弃用。
            px = rgb.load()
            def _edge_textured(points):
                vals = [px[p] for p in points]
                n = len(vals)
                means = [sum(v[i] for v in vals) / n for i in range(3)]
                var = sum(sum((v[i] - means[i]) ** 2 for i in range(3)) for v in vals) / n
                return var > 900  # 三通道方差和阈值≈17²×3, 纯色/轻噪不触发
            edges = {
                "上": [(x, 0) for x in range(0, w, 3)],
                "下": [(x, h - 1) for x in range(0, w, 3)],
                "左": [(0, y) for y in range(0, h, 3)],
                "右": [(w - 1, y) for y in range(0, h, 3)],
            }
            busy = [name for name, pts in edges.items() if _edge_textured(pts)]
            if busy:
                probs.append("%s边缘有内容纹理(文字/图形可能被裁, 建议标记里留边距)" % "/".join(busy))
    except Exception:
        pass  # 体检失败不阻断（体检是增强, 不是闸）
    return probs


def _is_blank_png(path):
    """纯色空白检测（自绘标记渲染翻车高频形态=整张全白）: RGB 全通道 min==max 判纯色。
    检测失败按非空白放行（宁可放过, 不误杀正常图）。"""
    try:
        from PIL import Image
        with Image.open(path) as im:
            ext = im.convert("RGB").getextrema()
        return all(lo == hi for lo, hi in ext)
    except Exception:
        return False


MAX_PAGE_MARKUP_PER_DECK = 16  # 页级自由渲染上限（Chrome ~3s/页; 16×3s≈48s, 距默认 300s 超时余量充足）


def _resolve_page_markup(spec, out_dir):
    """
    v2.0 平台化 → v3 收窄（凛倾 0717"组装出来的每层都是组件"）: 整页 html 内容页已废除
    （spec_norm._migrate_html_page 迁为 bg_html+deprecation 信号）, 本函数只剩装饰背景层
    一条通道: slide.bg_html → Chrome 渲 PNG → 走 bg_image 消费链, 垫在语义块之下
    （blocks 照常可编辑——文字与装饰分离协议）。
    失败/无 Chrome → 记 resolve_log, 无背景不阻断（离线硬约束）。
    """
    import os
    import asset_lib
    log = []
    made = 0
    for i, sl in enumerate(spec.get("slides", [])):
        if not isinstance(sl, dict) or not sl.get("bg_html") or sl.get("bg_image"):
            continue
        sid = sl.get("id") or ("s%d" % i)
        if made >= MAX_PAGE_MARKUP_PER_DECK:
            log.append({"action": "page_markup_skip", "slide": sid,
                        "detail": "超过单 deck 装饰层渲染上限 %d" % MAX_PAGE_MARKUP_PER_DECK})
            continue
        out_png = os.path.join(str(out_dir), "page_%s.png" % sid)
        # v2.2: 渲染尺寸随画布（run() 已先 set_canvas）
        _pw, _ph = round(solver.SLIDE_W_IN * 96), round(solver.SLIDE_H_IN * 96)
        try:
            hit = asset_lib.render_markup_png(sl["bg_html"], out_png, w=_pw, h=_ph)
        except Exception as e2:
            log.append({"action": "page_markup_error", "slide": sid, "detail": str(e2)[:120]})
            continue
        if hit and not _is_blank_png(hit):
            sl["bg_image"] = os.path.abspath(hit)
            made += 1
            log.append({"action": "page_markup", "slide": sid, "form": "bg",
                        "src": os.path.basename(hit)})
            # v2.1 渲染准度体检（信号回喂, 不拦产物）
            for prob in _check_markup_png(hit, expect_w=_pw, expect_h=_ph):
                log.append({"action": "page_markup_warn", "slide": sid, "detail": prob})
        else:
            log.append({"action": "page_markup_miss", "slide": sid,
                        "detail": "背景层渲染失败/空白/无Chrome, 无背景"})
    return log




def _resolve_spec_assets(spec, out_dir):
    """
    image block 带 query 无 src → 确定性素材解析（gen_spec CLI 独占能力收进主链路）：
      style=photo → Wikimedia Commons 联网检索（无网静默失败）→ 降插画
      style=icon  → Tabler 本地图标库（v1.5 激活 find_icon）
      style=illustration（缺省）→ unDraw 本地插画库
      style=diagram → 主链路无 LLM 出图配置, 诚实保持占位框（gen_spec CLI 路才有 AI SVG）
    任一环缺失（库未配置/无 Chrome/未命中）→ 保持占位框优雅降级, 结果记 resolve_log
    （离线硬约束: 本函数失败不阻断主流程, 核心生成不死依赖素材/网络）。
    """
    import os
    import asset_lib
    import style_packs
    import themes
    meta = spec.get("meta", {}) or {}
    th = style_packs.resolve_style(meta.get("theme")) or themes.resolve_theme(meta.get("theme"))
    accent = (th or {}).get("accent_color")
    log = []
    made = 0
    for sl in spec.get("slides", []):
        for b in sl.get("blocks", []):
            if b.get("kind") != "image" or made >= MAX_ASSETS_PER_DECK:
                continue
            style = str(b.get("style") or "illustration").lower()
            bid = b.get("id") or ("a%d" % made)
            out_png = os.path.join(str(out_dir), "asset_%s.png" % bid)
            # v1.7 配图容错: src 是 http(s) URL → 限时限量下载转本地; 失败→置 None 占位框
            #（solver src 校验只认本地文件, URL 原先静默变占位框零反馈）
            src0 = b.get("src")
            if isinstance(src0, str) and src0.strip().lower().startswith(("http://", "https://")):
                local = _download_image(src0.strip(), os.path.join(str(out_dir), "asset_%s" % bid))
                if local:
                    b["src"] = local
                    made += 1
                    log.append({"action": "asset", "block": bid, "style": "url",
                                "src": os.path.basename(local)})
                else:
                    b["src"] = None
                    log.append({"action": "asset_miss", "block": bid, "style": "url",
                                "detail": "下载失败/超时/非图片格式, 保持占位框", "url": src0[:120]})
                continue
            if src0:
                continue
            # v1.6: AI 自绘优先——image 块带 "svg"/"html" 标记 → Chrome 截 PNG 当 src
            # （补 diagram 缺口: spec 作者本身是 LLM, 自绘=零额外调用; 无 Chrome→占位框降级）
            markup = b.get("svg") or b.get("html")
            if markup:
                try:
                    hit = asset_lib.render_markup_png(markup, out_png, accent_hex=accent)
                    # v1.7: 纯色空白产物判 miss（标记语法翻车 Chrome 照样截一张全白, 不能当成功）
                    if hit and _is_blank_png(hit):
                        log.append({"action": "asset_miss", "block": bid, "style": "markup",
                                    "detail": "自绘渲染成纯色空白(标记可能非法), 保持占位框"})
                        continue
                except Exception as e:
                    log.append({"action": "asset_error", "block": bid, "detail": "自绘渲染失败: " + str(e)[:100]})
                    continue
                if hit:
                    b["src"] = os.path.abspath(hit)
                    made += 1
                    log.append({"action": "asset", "block": bid, "style": "markup",
                                "src": os.path.basename(hit)})
                    # v2.1 渲染准度体检（块级自绘同查, 尺寸不校=render_markup_png 自定画布）
                    for prob in _check_markup_png(hit):
                        log.append({"action": "asset_markup_warn", "block": bid, "detail": prob})
                else:
                    log.append({"action": "asset_miss", "block": bid, "style": "markup",
                                "detail": "无Chrome/空标记, 保持占位框"})
                continue
            q = str(b.get("query") or "").strip()
            if not q:
                continue
            hit = None
            try:
                if style == "photo":
                    hit = (asset_lib.get_photo_commons(q, out_png.replace(".png", ".jpg"))
                           or asset_lib.get_illustration_png(q, out_png, accent_hex=accent))
                elif style == "icon":
                    hit = asset_lib.get_icon_png(q, out_png, accent_hex=accent)
                elif style == "diagram":
                    log.append({"action": "asset_skip", "block": bid,
                                "detail": "diagram 主链路不出图: 在 image 块加 \"svg\" 字段自绘(v1.6), 保持占位框"})
                    continue
                else:
                    hit = asset_lib.get_illustration_png(q, out_png, accent_hex=accent)
            except Exception as e:
                log.append({"action": "asset_error", "block": bid, "detail": str(e)[:120]})
                continue
            if hit:
                b["src"] = os.path.abspath(hit)
                made += 1
                log.append({"action": "asset", "block": bid, "style": style,
                            "src": os.path.basename(hit)})
            else:
                log.append({"action": "asset_miss", "block": bid, "style": style, "query": q,
                            "detail": "未命中/素材库未配置/无Chrome, 保持占位框"})
    return log


# ---------------- 主编排 ----------------

def run(spec_path, out_dir=None, auto_resolve=True, max_iter=3, resolve_fn=None, animate=None,
        draft=False):
    """
    v2.0 draft=True（凛倾流程图阶段①「字符画定位+定位内容→给用户审查」）:
    只跑 归一+定位求解+字符画, 秒级返回; 跳过 Chrome/素材/PNG/pptx——
    两段式工作流: 草稿给用户审查, 过稿后再 generate 全量美化输出。
    """
    spec_path = Path(spec_path)
    out = Path(out_dir) if out_dir else HERE / "out"
    out.mkdir(parents=True, exist_ok=True)
    base_dir = str(spec_path.parent)

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    resolve_log = []
    # v1.7: spec 归一最前置（kind/region 别名归位后, 素材解析的 kind=='image' 判定才可靠）;
    # norm 信号不进回程闭环(策略修不了值域病, 防空转 max_iter), 结束后并入 signals 回喂
    norm_signals = solver.normalize_spec(spec)
    # v2.2: 画布先行切换（自由页渲染尺寸依赖; 信号由 solve() 单点收集, 此处丢弃防重复）
    solver.set_canvas((spec.get("meta") or {}).get("canvas"))
    if not draft:
        # v2.0: 页级 AI 代码渲染（自由页/背景层）在块级素材之前——两者共享 Chrome 通路,
        # 产物走 bg_image 消费链, solver._abs_img 只认存在的文件=渲染失败自然降级
        resolve_log += _resolve_page_markup(spec, out)
        # v1.5: 素材解析在 solve 之前（src 落定才能被 solver 解析为绝对路径）；
        # gen_spec.make_deck 已自解析的块带 src, 此处天然跳过（幂等, 不双跑）
        resolve_log += _resolve_spec_assets(spec, out)

    layout = solver.solve(spec, base_dir=base_dir)
    signals = _collect_signals(layout)

    it = 0
    while signals and auto_resolve and it < max_iter:
        it += 1
        new_spec = None
        if resolve_fn is not None:
            new_spec = resolve_fn(copy.deepcopy(spec), signals)  # LLM 钩子
        if new_spec is not None:
            spec = new_spec
            resolve_log.append({"iter": it, "action": "resolve_fn改写spec"})
        else:
            # v1.3: LLM 失败/未配置 → 确定性策略兜底(原先 None 直接 break=假兜底)
            action = None
            for sig in signals:  # 一轮修一个信号, 立即重solve看全局效果
                action = _apply_default_strategy(spec, sig)
                if action:
                    resolve_log.append({"iter": it, "signal": sig, "action": action})
                    break
            if action is None:
                resolve_log.append({"iter": it, "action": "无可自动修的信号, 交上游"})
                break
        layout = solver.solve(spec, base_dir=base_dir)
        signals = _collect_signals(layout)

    # 对比度自检(警告不阻断, 不参与闭环)。v0.5: 读 solver 解析后的 layout["theme"]——
    # 与渲染器同源(spec.meta.theme 可能是预设名字符串, 检查原始值=检查了错误对象)
    signals += contrast_signals(layout.get("theme"))
    # v1.7: 归一/坏页信号在闭环外并入（同 contrast 惯例: 警告回喂不参与自动重solve）
    signals += norm_signals + (layout.get("solve_errors") or [])
    raw_theme = spec.get("meta", {}).get("theme")
    if isinstance(raw_theme, str) and layout.get("theme") is None:
        signals.append({"type": "unknown_theme", "name": raw_theme,
                        "detail": "预设名不存在(themes.py PRESETS), 已按无主题渲染"})

    layout_path = out / "layout.json"
    layout_path.write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8")
    ascii_path = out / "preview_ascii.txt"
    ascii_path.write_text(ascii_view.render_ascii(layout), encoding="utf-8")
    if draft:
        # 草稿态: 字符画+信号即产物（给用户审查）, 不出 PNG/pptx
        return {"layout": str(layout_path), "ascii": str(ascii_path), "pngs": [],
                "pptx": None, "signals": signals, "resolve_log": resolve_log, "draft": True}
    # v3.1: deco art 小图渲染（最终 layout 上执行——闭环每轮重 solve, 早渲会丢）
    signals += _resolve_deco_art(layout, out)
    # v3 场景链（凛倾 0717 定案）: layout → compose 场景图（视觉决策单源）→ 双薄画笔。
    # scene.json 落盘=页级 op 的复用缓存位 + 可诊断工件
    sc = compose.compose(layout)
    signals += sc.pop("errors", [])
    (out / "scene.json").write_text(json.dumps(sc, ensure_ascii=False), encoding="utf-8")
    pngs, _perr = png_paint.render_png_scene(sc, str(out))
    pptx_path, _xerr = pptx_paint.render_pptx_scene(sc, str(out / "deck.pptx"))
    signals += _perr + _xerr

    # v2.5 参数图: interactive=true 的 chart 额外产自包含互动 HTML（附件交付,
    # pptx 内原生 chart 不受影响）; 失败只记 log 不阻断
    interactive_charts = []
    try:
        import interactive_chart
        interactive_charts = interactive_chart.emit_interactive_charts(layout, out)
        if interactive_charts:
            resolve_log.append({"action": "interactive_chart",
                                "files": [Path(p).name for p in interactive_charts]})
    except Exception as e:
        resolve_log.append({"action": "interactive_chart_error", "detail": str(e)[:120]})

    # v0.3 可选动画后处理: animate 非 None 时注入 <p:timing>（默认 None = 零行为变化）
    # v2.3: 值域单源 animate.MODES（JS 侧不再枚举白名单, 防双源）; 未知值退 fade+信号;
    #       页级 slide.animate 覆盖（"none"=该页关）, 页级未知值退 deck 级+信号
    if animate is not None:
        import animate as _animate  # 延迟导入, 不影响默认路径
        if animate not in _animate.MODES:
            signals.append({"type": "animate_fallback", "value": str(animate)[:30],
                            "detail": "未知动画, 可用 %s, 已用 fade" % "|".join(_animate.MODES)})
            animate = "fade"
        per_slide = [(sl.get("animate") if isinstance(sl, dict) else None)
                     for sl in spec.get("slides", [])]
        for _si, _m in enumerate(per_slide):
            if _m and str(_m).lower() not in _animate.MODES and str(_m).lower() != "none":
                signals.append({"type": "animate_fallback",
                                "slide": (spec["slides"][_si].get("id") or "s%d" % _si),
                                "value": str(_m)[:30],
                                "detail": "页级动画未知(可用 %s|none), 已退 deck 级" % "|".join(_animate.MODES)})
        # v3.2 组装容错: 动画后处理失败不炸管线——无动画 deck 仍是完整交付件
        try:
            pptx_path = _animate.add_animations(pptx_path, mode=animate, per_slide=per_slide)
        except Exception as e:
            signals.append({"type": "animate_error",
                            "detail": "动画注入失败(%s), 已交付无动画版本" % str(e)[:100]})

    return {
        "layout": str(layout_path),
        "ascii": str(ascii_path),
        "pngs": pngs,
        "pptx": pptx_path,
        "interactive_charts": interactive_charts,
        "signals": signals,
        "resolve_log": resolve_log,
    }


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    spec_file = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "spec_demo.json")
    out_arg = sys.argv[2] if len(sys.argv) > 2 else None  # 可指定输出目录, 防不同spec互相覆盖
    animate_arg = sys.argv[3] if len(sys.argv) > 3 else None  # v0.3 可选: fade|wipe, 缺省不加动画
    result = run(spec_file, out_dir=out_arg, animate=animate_arg)

    print(Path(result["ascii"]).read_text(encoding="utf-8"))
    print("=" * 60)
    for k in ("layout", "ascii", "pptx"):
        print(f"{k:>7}: {result[k]}")
    for p in result["pngs"]:
        print(f"    png: {p}")
    if result["resolve_log"]:
        print("\n[闭环日志]")
        print(json.dumps(result["resolve_log"], ensure_ascii=False, indent=2))
    if result["signals"]:
        print("\n[残余信号] 需上游AI/人决策:")
        print(json.dumps(result["signals"], ensure_ascii=False, indent=2))
    else:
        print("\n[信号] 无 —— 几何放置成功, 对比度达标")
