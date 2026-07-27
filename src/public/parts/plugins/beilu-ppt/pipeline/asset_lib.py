# -*- coding: utf-8 -*-
"""
asset_lib.py —— 本地前端资产库检索（v0.9, 凛倾: "找一个html/前端美化库"）

业界3分钟出PPT的核心=素材检索不现场生成。本模块:
  unDraw 1362张插画(MIT) + Tabler 5093图标(MIT), 全离线
  英文query → 文件名token匹配打分 → SVG主题色替换(#6c63ff=unDraw惯例主色) → Chrome截PNG
零 LLM 调用, 每张 ~3s(仅Chrome截图), 未命中由调用方降级到 AI 现场生成。
"""
import os
import re
import subprocess

# 素材库目录：环境变量配置（可选增强资源；未配置/不存在 → 检索返回 None，上游画占位框优雅降级）。
# 资源获取见 README（unDraw / tabler-icons / hero-patterns，均 MIT）。
import sys

UNDRAW_DIR = os.environ.get("BEILU_PPT_UNDRAW", "")
TABLER_DIR = os.environ.get("BEILU_PPT_TABLER", "")
PATTERNS_DIR = os.environ.get("BEILU_PPT_PATTERNS", "")


def _find_chrome():
    """Chrome 路径：env BEILU_PPT_CHROME 优先，其次常见安装位探测；找不到返回 None（SVG→PNG 截图降级）。"""
    cand = [os.environ.get("BEILU_PPT_CHROME", "")]
    if sys.platform == "win32":
        cand += [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                 r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"]
    elif sys.platform == "darwin":
        cand += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    else:
        cand += ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    for c in cand:
        if c and os.path.exists(c):
            return c
    return None


CHROME = _find_chrome()

_STOP = {"a", "an", "the", "of", "and", "in", "on", "for", "with", "at", "to"}


def _tokens(s):
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t and t not in _STOP]


def _score(query_toks, name_toks):
    """命中词数为主, 文件名短者优先(更贴切)。"""
    hits = sum(1 for t in query_toks if t in name_toks)
    # 前缀部分匹配算半分 (coffee 命中 coffees)
    partial = sum(0.5 for t in query_toks
                  if t not in name_toks and any(n.startswith(t) or t.startswith(n)
                                                for n in name_toks))
    if hits + partial == 0:
        return 0.0
    return hits + partial - 0.01 * len(name_toks)


def _search_dir(directory, query, exts=(".svg",)):
    if not directory or not os.path.isdir(directory):
        return None  # 素材库未配置/不存在 = 未命中，上游降级
    qt = _tokens(query)
    if not qt:
        return None
    best, best_s = None, 0.0
    for fn in os.listdir(directory):
        if not fn.endswith(exts):
            continue
        s = _score(qt, _tokens(fn))
        if s > best_s:
            best, best_s = fn, s
    return os.path.join(directory, best) if best else None


def find_illustration(query):
    """英文 query → unDraw SVG 路径或 None。"""
    return _search_dir(UNDRAW_DIR, query)


def find_icon(query):
    """英文 query → Tabler outline SVG 路径或 None。"""
    return _search_dir(TABLER_DIR, query)


def render_asset_png(svg_path, out_png, accent_hex=None, w=960, h=720, force_size=False):
    """
    SVG → PNG（Chrome headless, 与 gen_image 同渲染线）。
    accent_hex(无#): 替换 unDraw 惯例主题色 #6c63ff → 主题 accent, 插画随主题换装。
    force_size: True=强制铺满画布 90%（Tabler 图标自带 width='24' 内在尺寸,
    width:auto 会按 24px 渲染成小点; viewBox 存在时强制宽高等比放大不失真）。
    """
    if not CHROME:
        return None  # 无 Chrome = 无法截图渲染，上游降级
    with open(svg_path, encoding="utf-8") as f:
        svg = f.read()
    if accent_hex:
        svg = re.sub(r"#6[cC]63[fF]{2}", "#" + accent_hex, svg)
    # 等比嵌入画布中央(SVG自带viewBox, css contain 即可)
    # v1.5: body 设 CSS color——Tabler outline 图标 stroke="currentColor" 由此染 accent
    #（unDraw 不用 currentColor, 此规则对插画无副作用）
    color_css = ("color:#" + accent_hex + ";") if accent_hex else ""
    svg_css = ("svg{width:%dpx;height:%dpx}" % (int(w * 0.9), int(h * 0.9))
               if force_size else
               "svg{max-width:%dpx;max-height:%dpx;width:auto;height:auto}"
               % (int(w * 0.9), int(h * 0.9)))
    out_png = os.path.abspath(out_png)
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    html_path = out_png + ".html"
    with open(html_path, "w", encoding="utf-8") as f:
        f.write("<!DOCTYPE html><html><head><style>*{margin:0;padding:0}"
                "html,body{overflow:hidden;width:%dpx;height:%dpx;background:#fff;%s"
                "display:flex;align-items:center;justify-content:center}"
                "%s</style></head><body>%s</body></html>"
                % (w, h, color_css, svg_css, svg))
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    "--screenshot=" + out_png, "--window-size=%d,%d" % (w, h),
                    "file:///" + html_path.replace("\\", "/")],
                   capture_output=True, timeout=60, check=True)
    os.remove(html_path)
    return out_png


def render_markup_png(markup, out_png, accent_hex=None, w=960, h=720, transparent=False):
    """
    v1.6: AI 自绘配图——spec 的 image 块直接携带 svg/html 标记, 经既有 Chrome 截图通路出 PNG
    （补 diagram 缺口: 主链路原先只能占位框, AI 写 spec 时本身就是 LLM, 让它顺手把图画了=零额外调用）。
    <svg ...> 片段 → 居中 contain 嵌画布(同 render_asset_png 形态); 完整 <html>/<!DOCTYPE> → 原样整页截。
    无 Chrome/空标记返回 None, 上游占位框优雅降级。--screenshot 为同步一次性截图, 含异步 JS 的
    HTML 不保证渲染完成——引导侧约定只用静态 SVG/HTML+CSS。
    v3.1 transparent=True: deco art 小图用——包装层透明底 + Chrome 透明背景旗标,
    小图叠在任意页底色上不带白框（凛倾 0717: 前端代码只用于美化小组件转小图）。
    """
    if not CHROME:
        return None
    m = str(markup or "").strip()
    if not m or "<" not in m:
        return None  # v1.7: 无任何标签形态=纯文本误填, 判 miss 占位框
    out_png = os.path.abspath(out_png)
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    html_path = out_png + ".html"
    bg_css = "background:transparent;" if transparent else "background:#fff;"
    if re.match(r"(?is)\s*(<!doctype|<html)", m):
        doc = m
    else:
        color_css = ("color:#" + accent_hex + ";") if accent_hex else ""
        doc = ("<!DOCTYPE html><html><head><meta charset='utf-8'><style>*{margin:0;padding:0}"
               "html,body{overflow:hidden;width:%dpx;height:%dpx;%s%s"
               "display:flex;align-items:center;justify-content:center}"
               "svg{max-width:%dpx;max-height:%dpx;width:auto;height:auto}"
               "</style></head><body>%s</body></html>"
               % (w, h, bg_css, color_css, int(w * 0.96), int(h * 0.96), m))
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(doc)
    args = [CHROME, "--headless", "--disable-gpu",
            "--screenshot=" + out_png, "--window-size=%d,%d" % (w, h)]
    if transparent:
        args.append("--default-background-color=00000000")
    args.append("file:///" + html_path.replace("\\", "/"))
    subprocess.run(args, capture_output=True, timeout=60, check=True)
    os.remove(html_path)
    return out_png


def get_illustration_png(query, out_png, accent_hex=None, w=960, h=720):
    """检索+渲染一步到位。未命中返回 None（调用方降级 AI 生成）。"""
    svg = find_illustration(query)
    if not svg:
        return None
    return render_asset_png(svg, out_png, accent_hex=accent_hex, w=w, h=h)


def get_icon_png(query, out_png, accent_hex=None, w=480, h=480):
    """v1.5: Tabler 图标检索+渲染一步到位（stroke=currentColor 经 CSS color 染 accent）。
    未命中/无库/无 Chrome 返回 None（调用方占位框降级）。"""
    svg = find_icon(query)
    if not svg:
        return None
    return render_asset_png(svg, out_png, accent_hex=accent_hex, w=w, h=h, force_size=True)


def get_pattern_png(name_query, out_png, fg_hex="CADCFC", bg_hex="FFFFFF",
                    opacity=0.35, w=1280, h=720):
    """
    v1.1 背景纹理(hero-patterns 100个MIT平铺tile): 检索→染色→CSS repeat平铺→截PNG。
    秒级替代 AI 现场画背景(20-40s+方差)。opacity=纹理淡度(内容页要极淡如0.06-0.12)。
    """
    import base64
    import subprocess
    if not CHROME:
        return None  # 无 Chrome = 无法截图渲染，上游降级
    svg_path = _search_dir(PATTERNS_DIR, name_query)
    if not svg_path:
        return None
    with open(svg_path, encoding="utf-8") as f:
        svg = f.read()
    svg = re.sub(r'fill="#[0-9a-fA-F]{3,6}"', 'fill="#%s"' % fg_hex, svg)
    svg = re.sub(r"fill='#[0-9a-fA-F]{3,6}'", "fill='#%s'" % fg_hex, svg)
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    out_png = os.path.abspath(out_png)
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    html_path = out_png + ".html"
    # 纹理平铺 + 顶层同色遮罩控制淡度(1-opacity 的不透明遮罩)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write("<!DOCTYPE html><html><head><style>*{margin:0;padding:0}"
                "html,body{overflow:hidden;width:%dpx;height:%dpx;background:#%s}"
                "body{background-image:url(data:image/svg+xml;base64,%s);"
                "background-repeat:repeat}"
                "body::after{content:'';position:fixed;top:0;left:0;right:0;bottom:0;"
                "background:#%s;opacity:%.3f}"
                "</style></head><body></body></html>"
                % (w, h, bg_hex, b64, bg_hex, 1 - opacity))
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    "--screenshot=" + out_png, "--window-size=%d,%d" % (w, h),
                    "file:///" + html_path.replace("\\", "/")],
                   capture_output=True, timeout=60, check=True)
    os.remove(html_path)
    return out_png


def get_photo_commons(query, out_path, timeout=30, min_kb=30):
    """
    v1.3 真实照片(Wikimedia Commons API): 免key/CC授权/直链稳定——
    DDG 图搜被反爬拦(v1.1实测)、LLM grounding 不给文件直链(200但text空, 实测),
    Commons 是"AI出检索词→管线搜图下载"的可靠形态。失败返回 None。
    """
    import urllib.request, urllib.parse, json as _json
    ua = {"User-Agent": "pptx-pipeline/1.0 (research; contact local)"}
    try:
        api = ("https://commons.wikimedia.org/w/api.php?action=query&generator=search"
               "&gsrsearch=" + urllib.parse.quote("filetype:bitmap " + query) +
               "&gsrnamespace=6&gsrlimit=5&prop=imageinfo&iiprop=url|size"
               "&iiurlwidth=1280&format=json")
        req = urllib.request.Request(api, headers=ua)
        data = _json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8"))
        pages = (data.get("query", {}) or {}).get("pages", {}) or {}
        # 按搜索相关序(index)排
        cands = sorted(pages.values(), key=lambda p: p.get("index", 99))
        out_path = os.path.abspath(out_path)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        for p in cands:
            infos = p.get("imageinfo") or []
            if not infos:
                continue
            url = infos[0].get("thumburl") or infos[0].get("url")
            if not url:
                continue
            try:
                raw = urllib.request.urlopen(
                    urllib.request.Request(url, headers=ua), timeout=timeout).read()
                if len(raw) < min_kb * 1024:
                    continue
                with open(out_path, "wb") as f:
                    f.write(raw)
                from PIL import Image
                with Image.open(out_path) as im:
                    im.verify()
                return out_path
            except Exception:
                continue
    except Exception:
        pass
    return None


def get_photo(query, out_png, timeout=30):
    """
    v1.1 真实照片检索(照 beilu webSearch 无key爬取哲学, 移植 DDG images 线):
    duckduckgo i.js 端点 → 首个可下载图 → 存本地。失败返回 None(调用方降级插画/占位)。
    """
    import urllib.request, urllib.parse, json as _json, re as _re
    ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    try:
        # 1) 拿 vqd token(DDG 图搜必需)
        q = urllib.parse.quote(query)
        req = urllib.request.Request("https://duckduckgo.com/?q=%s&iax=images&ia=images" % q,
                                     headers=ua)
        html = urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")
        m = _re.search(r"vqd=([\d-]+)", html) or _re.search(r'vqd="([^"]+)"', html)
        if not m:
            return None
        vqd = m.group(1)
        # 2) 图片结果 JSON
        req2 = urllib.request.Request(
            "https://duckduckgo.com/i.js?l=us-en&o=json&q=%s&vqd=%s&f=,,,&p=1" % (q, vqd),
            headers={**ua, "Referer": "https://duckduckgo.com/"})
        data = _json.loads(urllib.request.urlopen(req2, timeout=timeout).read().decode("utf-8"))
        out_png = os.path.abspath(out_png)
        os.makedirs(os.path.dirname(out_png), exist_ok=True)
        for item in (data.get("results") or [])[:5]:
            url = item.get("image")
            if not url:
                continue
            try:
                req3 = urllib.request.Request(url, headers=ua)
                raw = urllib.request.urlopen(req3, timeout=timeout).read()
                if len(raw) < 20 * 1024:
                    continue
                with open(out_png, "wb") as f:
                    f.write(raw)
                from PIL import Image
                with Image.open(out_png) as im:
                    im.verify()  # 坏图淘汰
                return out_png
            except Exception:
                continue
    except Exception:
        pass
    return None


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    for q in ["coffee shop interior", "community people social", "revenue growth chart", "barista"]:
        hit = find_illustration(q)
        print("%-28s ->" % q, os.path.basename(hit) if hit else "MISS")
    p = get_illustration_png("coffee shop", os.path.join(os.path.dirname(__file__), "out", "asset_probe.png"),
                             accent_hex="84B59F")
    print("rendered:", p)
