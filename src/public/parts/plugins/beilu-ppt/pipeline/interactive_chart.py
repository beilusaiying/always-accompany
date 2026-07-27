# -*- coding: utf-8 -*-
"""
interactive_chart.py —— 参数图互动 HTML（v2.5, 凛倾流程图"参数图: 互动-参数-美化-函数"）

职责: chart box(interactive=true) → 自包含互动 HTML 附件（浏览器打开即玩）。
互动域: 悬浮显示数值 / 系列显隐勾选 / 柱↔折线切换 / 数值缩放滑杆（参数）。
铁律: 零 CDN 零外部依赖（离线硬约束）——手写 SVG+原生 JS 全部内联; 美化=主题四色注入。
pptx 内保持原生可编辑 chart 不受影响（互动件是并行附件, 不替代）。
"""
import json

_TEMPLATE = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<title>__TITLE__</title>
<style>
 body{margin:0;font-family:'Microsoft YaHei',sans-serif;background:__BG__;color:__BODY__;
      display:flex;flex-direction:column;align-items:center;padding:24px}
 h1{font-size:20px;color:__TITLECOL__;margin:0 0 12px}
 .bar{fill:__ACCENT__}
 .ctrl{margin:10px 0;display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:13px}
 .ctrl label{cursor:pointer;user-select:none}
 #tip{position:fixed;pointer-events:none;background:#000c;color:#fff;padding:4px 8px;
      border-radius:4px;font-size:12px;display:none}
 svg{background:__BG__;max-width:96vw}
 button{border:1px solid __ACCENT__;background:none;color:__ACCENT__;border-radius:4px;
        padding:3px 10px;cursor:pointer}
</style></head><body>
<h1>__TITLE__</h1>
<div class="ctrl">
  <button id="toggle">柱/折线切换</button>
  <span>数值缩放 <input id="scale" type="range" min="10" max="200" value="100">
  <span id="scaleV">100%</span></span>
  <span id="legend"></span>
</div>
<svg id="c" width="960" height="480" viewBox="0 0 960 480"></svg>
<div id="tip"></div>
<script>
const DATA = __DATA__;
const ACCENT = "__ACCENT__", PALETTE = [ACCENT, "#5B9BD5", "#70AD47", "#FFC000", "#9B6BF2", "#E45F3C"];
let mode = "__MODE__", scale = 1, hidden = new Set();
const svg = document.getElementById("c"), tip = document.getElementById("tip");
const W = 960, H = 480, PL = 60, PB = 40, PT = 20;
function draw(){
  const cats = DATA.categories, series = DATA.series.filter((s,i)=>!hidden.has(i));
  const all = series.flatMap(s=>s.values.map(v=>v*scale));
  const mx = Math.max(1, ...all);
  let out = "";
  for(let g=0; g<=4; g++){
    const y = PT + (H-PB-PT)*g/4, v = (mx*(4-g)/4);
    out += `<line x1="${PL}" y1="${y}" x2="${W-10}" y2="${y}" stroke="#8884" stroke-width="1"/>`
         + `<text x="${PL-6}" y="${y+4}" font-size="11" fill="__BODY__" text-anchor="end">${v.toFixed(v>=10?0:1)}</text>`;
  }
  const gw = (W-PL-10)/cats.length;
  cats.forEach((c,ci)=>{ out += `<text x="${PL+gw*ci+gw/2}" y="${H-PB+16}" font-size="12" fill="__BODY__" text-anchor="middle">${c}</text>`; });
  const nS = series.length || 1;
  series.forEach((s, si)=>{
    const col = PALETTE[DATA.series.indexOf(s) % PALETTE.length];
    if(mode === "bar"){
      const bw = gw/(nS+1);
      s.values.forEach((v,ci)=>{
        const h = (H-PB-PT)*(v*scale)/mx, x = PL+gw*ci+bw*(si+0.5), y = H-PB-h;
        out += `<rect x="${x}" y="${y}" width="${bw*0.9}" height="${h}" fill="${col}" data-v="${s.name}: ${v}"/>`;
      });
    } else {
      const pts = s.values.map((v,ci)=>`${PL+gw*ci+gw/2},${H-PB-(H-PB-PT)*(v*scale)/mx}`).join(" ");
      out += `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.5"/>`;
      s.values.forEach((v,ci)=>{
        out += `<circle cx="${PL+gw*ci+gw/2}" cy="${H-PB-(H-PB-PT)*(v*scale)/mx}" r="4" fill="${col}" data-v="${s.name}: ${v}"/>`;
      });
    }
  });
  svg.innerHTML = out;
}
function legend(){
  document.getElementById("legend").innerHTML = DATA.series.map((s,i)=>
    `<label><input type="checkbox" data-i="${i}" ${hidden.has(i)?"":"checked"}> <span style="color:${PALETTE[i%PALETTE.length]}">■</span>${s.name||("系列"+(i+1))}</label>`).join(" ");
}
document.getElementById("toggle").onclick = ()=>{ mode = mode==="bar"?"line":"bar"; draw(); };
document.getElementById("scale").oninput = (e)=>{ scale = e.target.value/100; document.getElementById("scaleV").textContent = e.target.value+"%"; draw(); };
document.getElementById("legend").onchange = (e)=>{ const i = +e.target.dataset.i; e.target.checked?hidden.delete(i):hidden.add(i); draw(); };
svg.addEventListener("mousemove", (e)=>{
  const t = e.target.closest("[data-v]");
  if(t){ tip.style.display="block"; tip.textContent=t.dataset.v; tip.style.left=(e.clientX+12)+"px"; tip.style.top=(e.clientY-8)+"px"; }
  else tip.style.display="none";
});
legend(); draw();
</script></body></html>
"""


def emit_interactive_charts(layout, out_dir):
    """layout 里 interactive=true 的 chart → 每个一份自包含 HTML。返回 [文件路径]。"""
    import os
    theme = layout.get("theme") or {}
    colors = {
        "__BG__": "#" + str(theme.get("bg_color") or "FFFFFF"),
        "__BODY__": "#" + str(theme.get("body_color") or "333333"),
        "__TITLECOL__": "#" + str(theme.get("title_color") or "111111"),
        "__ACCENT__": "#" + str(theme.get("accent_color") or "4472C4"),
    }
    paths = []
    for sl in layout.get("slides", []):
        for b in sl.get("boxes", []):
            if b.get("kind") != "chart" or not b.get("interactive"):
                continue
            if not b.get("series"):
                continue  # normalize 已把坏数据降级 text, 此处只防御空
            html = _TEMPLATE
            for k, v in colors.items():
                html = html.replace(k, v)
            html = (html
                    .replace("__TITLE__", str(b.get("title") or b.get("id") or "参数图"))
                    .replace("__MODE__", "line" if b.get("chart_type") == "line" else "bar")
                    .replace("__DATA__", json.dumps(
                        {"categories": b.get("categories") or [], "series": b.get("series") or []},
                        ensure_ascii=False)))
            p = os.path.join(str(out_dir), "chart_%s.html" % (b.get("id") or len(paths)))
            with open(p, "w", encoding="utf-8") as f:
                f.write(html)
            paths.append(os.path.abspath(p))
    return paths
