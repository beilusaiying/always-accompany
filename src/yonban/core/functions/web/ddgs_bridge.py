#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ddgs_bridge.py — 联网搜索的 Python 通道桥（webSearch "ddgs" 引擎的子进程实现）。

【功能链】
  executeWebSearch(engine="ddgs") → webSearch.searchViaDdgs()
  → Deno.Command 起 python -X utf8 本文件 → 本文件调 ddgs 库 → stdout 输出单行 JSON
  → JS 侧解析回统一 SearchResult[]

【why 走 Python 子进程而不是在 Deno 里实现·002 2026-07-26「我们的项目有python,直接按照插件接个shell」】
  0726 实测确诊：本机对 bing 的裸请求，Deno fetch 8s 超时、playwright ctx.request 亦失败，
  而 ddgs（Python）1.7s 稳定拿到 5 条——同机同出口同时段，唯一变量是 **TLS/JA3 指纹**。
  ddgs 依赖的 primp 是 Rust 客户端，在传输层伪装真实浏览器的 TLS 握手与 HTTP2 帧序；
  Deno/Node 的 fetch 指纹固定且可被识别为非浏览器，改 User-Agent 属应用层——UA 说是 Chrome
  而 TLS 说不是，反而构成更强的 bot 信号。这一层在 JS 运行时内无法自持修复。
  进程边界本就可以跨语言（beilu 已有 beilu-ppt / beilu-plugin-host 两处 Python 子进程范式），
  语言不是约束。相比浏览器通道（2.5~27s、间歇人机验证），本通道 1.4~2.2s 且不触发验证。

【契约】
  入参：argv[1]=query，argv[2]=max_results，argv[3]=backend（auto|bing|yandex|yahoo|...），
        argv[4]=timeout 秒，argv[5]=proxy（空串=不用），argv[6]=category（text|images|news），argv[7]=region（空=按查询语言自动）
  出参：stdout 单行 JSON —— {"ok":true,"results":[{title,url,snippet}]} 或 {"ok":false,"error":"..."}
        **只在 stdout 写这一行**（其余诊断一律 stderr），JS 侧按行解析不做容错猜测。
  依赖缺失（未 pip install ddgs）→ ok:false + 可执行安装动线，不静默空结果。

【关联链】
  ← webSearch.mjs（searchViaDdgs，Deno.Command 调用）
  → ddgs（第三方库，用户自行安装；缺失时本桥诚实报错）

【影响范围】
  纯计算 + 出站 HTTP；不写磁盘、不改环境。
"""
import json
import sys


def _out(obj):
    """结果只走 stdout 单行 JSON（诊断走 stderr，防污染契约）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def main():
    argv = sys.argv[1:]
    if not argv or not argv[0].strip():
        _out({"ok": False, "error": "查询词为空"})
        return

    query = argv[0]
    max_results = int(argv[1]) if len(argv) > 1 and argv[1].isdigit() else 5
    backend = (argv[2].strip() if len(argv) > 2 else "") or "auto"
    timeout = int(argv[3]) if len(argv) > 3 and argv[3].isdigit() else 10
    proxy = argv[4].strip() if len(argv) > 4 else ""
    category = (argv[5].strip().lower() if len(argv) > 5 else "") or "text"  # text | images | news
    region = argv[6].strip() if len(argv) > 6 else ""    # 空=按查询语言自动（见下）

    try:
        from ddgs import DDGS
    except ImportError:
        # need_install 标记交由 JS 侧决定是否后台安装（见 webSearch.searchViaDdgs）。
        # why 不在此处同步 pip install：首次安装可能 30s+，远超搜索超时，进程会被外层砍掉，
        #   既装不完也拿不到结果。改为"本次诚实失败 + 后台装 + 下次可用"，
        #   并发容错本就允许单平台缺席（其余平台兜底），用户感知不到中断。
        _out({
            "ok": False,
            "need_install": True,
            "error": "Python 搜索通道依赖未安装（ddgs）——已触发后台自动安装，稍后重试即可；也可手动执行 `pip install ddgs`",
        })
        return

    try:
        kw = {"timeout": timeout}
        if proxy:
            kw["proxy"] = proxy
        client = DDGS(**kw)
        # backend="auto" 时库内部按序试多个引擎（更稳但更慢，实测 5-6s）；
        # 指定单后端最快（实测 bing 1.7s / yandex 1.4s）——取舍交由调用方配置，此处不代为决定。
        # category 决定调哪个方法与结果字段族（002 0726「注意图片类型的读取」）：
        #   text   → TextResult   {title, href, body}
        #   images → ImagesResult {title, image, thumbnail, url, height, width, source}
        #   news   → NewsResult   {date, title, body, url, image, source}
        # 三者字段名不同，**不能共用一套取法**——images 没有 href/body，按 text 的取法会得到空结果
        # 且不报错（静默返回 0 条，是最难查的那类失效）。
        # region 决定上游引擎的 cc/setlang。库默认 "us-en"——中文查询会拿回整页英文结果，
        # 进而被本项目的投毒检测判为"与查询无关"而全灭（0726 实测 news 类 4 条全灭即此因）。
        # 空=按查询是否含 CJK 自动选，用户可用 ddgs_region 显式覆盖（禁硬编码：值可改）。
        rg = region or ("cn-zh" if any("一" <= ch <= "鿿" for ch in query) else "us-en")
        kwargs = {"max_results": max_results, "backend": backend, "region": rg}
        if category == "images":
            hits = client.images(query, **kwargs)
        elif category == "news":
            hits = client.news(query, **kwargs)
        else:
            hits = client.text(query, **kwargs)
    except Exception as e:  # noqa: BLE001 — 库抛自有异常族，统一转契约错误上行
        _out({"ok": False, "error": "{}: {}".format(type(e).__name__, str(e)[:200])})
        return

    results = []
    for h in (hits or [])[:max_results]:
        if category == "images":
            # url 取**来源页面**而非图片直链：下游的去重/域名过滤/正文校验都按"可访问的页面"工作，
            # 用图片直链会让域名统计失真（图床域名）且正文校验抓到二进制。图片直链走独立字段 image。
            page = (h.get("url") or "").strip()
            img = (h.get("image") or "").strip()
            if not page and not img:
                continue
            results.append({
                "title": (h.get("title") or "").strip(),
                "url": page or img,
                "image": img,
                "thumbnail": (h.get("thumbnail") or "").strip(),
                "width": h.get("width") or "",
                "height": h.get("height") or "",
                # snippet 给尺寸+来源站：图片结果没有正文摘要，留空会让下游相关性算法拿不到任何文本信号
                "snippet": "图片 {}x{} 来源: {}".format(h.get("width") or "?", h.get("height") or "?", h.get("source") or "?"),
            })
        elif category == "news":
            url = (h.get("url") or h.get("href") or "").strip()
            if not url:
                continue
            results.append({
                "title": (h.get("title") or "").strip(),
                "url": url,
                "snippet": (h.get("body") or "").strip(),
                "date": (h.get("date") or "").strip(),
                "image": (h.get("image") or "").strip(),
            })
        else:
            url = h.get("href") or h.get("url") or ""
            if not url:
                continue
            results.append({
                "title": (h.get("title") or "").strip(),
                "url": url,
                "snippet": (h.get("body") or "").strip(),
            })
    _out({"ok": True, "results": results, "backend": backend, "category": category})


if __name__ == "__main__":
    main()
