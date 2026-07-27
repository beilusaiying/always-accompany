# -*- coding: utf-8 -*-
"""
gen_image.py —— Gemini 出图接入（v0.6, 照 beilu 的线: yonban/core/functions/api/gemini/main.mjs）

线路（与 beilu 同构）: 原生 generateContent + responseModalities ['IMAGE','TEXT']，
响应 candidates[].content.parts[].inlineData.data = base64 图。
网关: new-api 型（/v1beta/models/{model}:generateContent, Bearer 或 x-goog-api-key）。
配置从 api_config.json 读（不硬编码 key 进代码）。
"""
import base64
import json
import os
import ssl
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_cfg():
    p = os.path.join(HERE, "api_config.json")
    if not os.path.exists(p):
        raise RuntimeError(
            "api_config.json 未配置：复制同目录 api_config.example.json 为 api_config.json，"
            "填入你的网关地址与 key（AI 出图/gen_spec 文本生成用；beilu 的 ppt_op 主链路不需要它）")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def generate_image(prompt, out_path, model=None, timeout=180):
    """文生图 → 存 PNG。返回 out_path；失败抛异常（不吞错）。"""
    cfg = _load_cfg()
    model = model or cfg.get("image_model", "gemini-3.5-flash")
    url = "%s/v1beta/models/%s:generateContent" % (cfg["base_url"].rstrip("/"), model)
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]},
    }
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg["api_key"],
                 "x-goog-api-key": cfg["api_key"],
                 # WAF 拦无 UA 的裸 urllib 请求(实测403, PowerShell同请求200), 补 UA 即过
                 "User-Agent": "Mozilla/5.0 (pipeline gen_image)"},
        method="POST")
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        resp = json.loads(r.read().decode("utf-8"))

    for cand in resp.get("candidates", []):
        for part in (cand.get("content", {}) or {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
                with open(out_path, "wb") as f:
                    f.write(base64.b64decode(inline["data"]))
                return out_path
    raise RuntimeError("响应无图: %s" % json.dumps(resp, ensure_ascii=False)[:500])


def generate_text(prompt, model=None, timeout=300, use_search=False):
    """
    纯文本生成（thinking 关闭, 过滤 thought part）。
    走流式 SSE：长生成时非流式会被网关 CDN 524 切断(实测)——流式持续有字节即不超时。
    use_search: v1.1 原生 google_search grounding(网关实测透传, 有groundingMetadata)。
    """
    cfg = _load_cfg()
    model = model or cfg.get("image_model", "gemini-3.5-flash")
    # use_search 时走非流式: 网关的 stream+tools 组合 503(实测), 非流式+tools 200(grounding探针实测);
    # 搜索类查询输出短, 不会撞 CDN 100s(那是长spec生成的问题)
    stream = not use_search
    ep = ":streamGenerateContent?alt=sse" if stream else ":generateContent"
    url = "%s/v1beta/models/%s%s" % (cfg["base_url"].rstrip("/"), model, ep)
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"thinkingConfig": {"thinkingBudget": 0}},
    }
    if use_search:
        body["tools"] = [{"google_search": {}}]
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "x-goog-api-key": cfg["api_key"],
                 "User-Agent": "Mozilla/5.0 (pipeline gen_image)",
                 "Accept": "text/event-stream"},
        method="POST")
    out = []
    with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
        if not stream:
            resp = json.loads(r.read().decode("utf-8"))
            parts = (resp.get("candidates", [{}])[0].get("content", {}) or {}).get("parts", [])
            return "".join(p.get("text", "") for p in parts if not p.get("thought"))
        for raw_line in r:
            line = raw_line.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload in ("", "[DONE]"):
                continue
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue
            for cand in chunk.get("candidates", []):
                for p in (cand.get("content", {}) or {}).get("parts", []):
                    if p.get("text") and not p.get("thought"):
                        out.append(p["text"])
    return "".join(out)


from asset_lib import _find_chrome
CHROME = _find_chrome()  # None = 无 Chrome，generate_svg_png 会给出明确错误


def generate_svg_png(prompt, out_png, w=1280, h=720, timeout=120):
    """
    v0.6 绚丽化主线（此网关无位图模型, 503 实测）:
    Gemini 出 SVG(矢量, 文本模型强项) → Chrome headless 截图 → PNG。
    """
    import subprocess
    svg = generate_text(
        prompt + "\nOutput ONLY the raw SVG code with viewBox=\"0 0 %d %d\", "
                 "no markdown fence, no explanation." % (w, h),
        timeout=timeout).strip()
    # 清洗: 模型偶尔仍包 markdown fence
    if svg.startswith("```"):
        svg = svg.split("```")[1]
        svg = svg[3:] if svg[:3].lower() == "svg" else svg
    i = svg.find("<svg")
    if i < 0:
        raise RuntimeError("响应非SVG: %.200s" % svg)
    j = svg.rfind("</svg>")
    if j < 0:
        # 网关流间歇性掐断(实测: 同prompt时945字符断/时6936完整)——截断当失败抛出,
        # 让上层 retries 真正生效; 原先切成5字符渲成白图=假成功
        raise RuntimeError("SVG被截断(len=%d, 无</svg>)" % len(svg))
    svg = svg[i:j + 6]

    out_png = os.path.abspath(out_png)
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    html_path = out_png + ".html"
    # 内联 SVG + overflow:hidden——fetch 异步有竞态、滚动条会入画(探针实测)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write("<!DOCTYPE html><html><head><style>*{margin:0;padding:0}"
                "html,body{overflow:hidden;width:%dpx;height:%dpx}"
                "svg{display:block;width:%dpx;height:%dpx}</style></head><body>%s</body></html>"
                % (w, h, w, h, svg))
    if not CHROME:
        raise RuntimeError("未找到 Chrome/Chromium：设置环境变量 BEILU_PPT_CHROME 指向浏览器可执行文件（SVG→PNG 截图渲染用）")
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    "--screenshot=" + out_png, "--window-size=%d,%d" % (w, h),
                    "file:///" + html_path.replace("\\", "/")],
                   capture_output=True, timeout=90, check=True)
    os.remove(html_path)
    return out_png


def png_richness(png_path):
    """v0.8 插图质检: 非白像素占比(0~1)。LLM SVG 方差大, 偶出近空白图。"""
    from PIL import Image
    with Image.open(png_path) as im:
        im = im.convert("L").resize((160, 120))
        px = list(im.getdata())
    return sum(1 for v in px if v < 245) / len(px)


def generate_illustration(subject, out_png, w=960, h=720, min_richness=0.08, retries=2):
    """带质检的插图生成: 空白图自动重roll, 仍空返回 None(调用方退占位)。"""
    prompt = ("Flat vector illustration for a presentation slide, subject: %s. "
              "Rich colorful composition that FILLS the whole canvas: large foreground "
              "objects, layered background shapes, warm cohesive palette, "
              "no text, no watermark" % subject)
    for i in range(retries + 1):
        try:
            generate_svg_png(prompt, out_png, w=w, h=h)
            if png_richness(out_png) >= min_richness:
                return out_png
        except Exception:
            pass
    return None


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    p1 = generate_svg_png(
        "Decorative slide deck COVER background: deep navy (#1E2761) base with subtle "
        "radial gradient, thin glowing ice-blue (#CADCFC) geometric network lines and "
        "bright nodes concentrated in the four corners, center area kept clean and dark "
        "for title text, elegant, premium, minimal",
        os.path.join(HERE, "assets", "bg_cover.png"))
    print("saved:", p1)
    p2 = generate_svg_png(
        "Very subtle slide deck CONTENT PAGE background: white (#FFFFFF) base, extremely "
        "faint ice-blue (#CADCFC at ~15% opacity) thin geometric network lines and tiny "
        "nodes only along the bottom-right corner and top edge, 90% of canvas stays pure "
        "white for text readability, barely visible, elegant",
        os.path.join(HERE, "assets", "bg_content.png"))
    print("saved:", p2)
