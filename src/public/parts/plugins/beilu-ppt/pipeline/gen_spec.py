# -*- coding: utf-8 -*-
"""
gen_spec.py —— 端到端: 用户需求 → flash 出 spec → 管线渲染（v0.7）

回答的问题: gemini-3.5-flash 能不能【单独】基于本管线+提示词做出 PPT。
分工不变: flash 只做语义层(标题/要点/区域/占比, 零坐标), 几何仍归 solver。
提示词=压缩版契约 schema + 官方设计规范(勿纯文字页/版式轮换/每页有视觉元素)。
"""
import json
import os
import sys

import asset_lib
import gen_image
import pipeline

HERE = os.path.dirname(os.path.abspath(__file__))

SPEC_PROMPT = """你是幻灯片内容设计师。根据用户需求输出一份 JSON 幻灯片规格(spec)。只输出 JSON，不要 markdown 围栏，不要解释。

## Schema
{
 "meta": {"title": "整套标题", "theme": "<预设名>", "bg_prompt": "<英文一句话,切合主题的封面装饰背景SVG,深色底/角落装饰/中央留空>", "content_pattern": "<内容页背景纹理,从这些名字选一个切合主题的: topography|circuit-board|leaf|endless-clouds|floating-cogs|jigsaw|texture|formal-invitation>"},
 "slides": [
  {"id": "cover", "type": "cover", "title": "<副标题>"},
  {"id": "s1", "title": "<页标题>", "blocks": [<block>...]},
  ...
 ]
}
block 类型（kind）:
- {"id","kind":"bullets","items":["要点"...],"region","weight"} 要点列表(每条<40字, 每块3-5条)
- {"id","kind":"text","text":"一段话","region","weight"} 说明段
- {"id","kind":"stat","value":"大数字/短词","label":"一句解释","region","weight"} 大数字强调
- {"id","kind":"chart","chart_type":"bar|line|pie","title","categories":[...],"series":[{"name","values":[数字...]}],"region","weight"} 数据图表
- {"id","kind":"image","placeholder":"图片中文说明","query":"<2-4个英文词,概括图片主题,用于插画库检索,如 coffee shop / team meeting>","region","weight"} 插图
- {"id","kind":"table","headers":["列名"...],"rows":[["单元格"...]...],"caption":"<一句表注>","region","weight"} 数据表格(结构化对照/多列数据)
region ∈ left|center|right|top|bottom|full；weight=同排块的宽度占比(数字)
region 用法: 主内容一律放 left/center/right/full（它们占据页面主体）; top/bottom 是薄辅助带（最高1.2英寸）只放一行备注/短标语, 禁止放 chart/stat/主要内容, 禁止一页只有 top+bottom
theme 预设名任选其一: midnight_executive, forest_moss, coral_energy, warm_terracotta, ocean_gradient, charcoal_minimal, teal_trust, berry_cream, sage_calm, cherry_bold（选切合主题气质的, 别默认第一个）

## 设计规范（必须遵守）
- 第一页必须是 cover；总页数 5-7 页
- 每页必须有至少一个视觉元素(stat/chart/image), 禁止纯文字页
- 版式轮换: 相邻页不用同一种布局(左右分栏/三列/full+底注 轮换)
- 有数据就用 chart(编造合理示例数据), 有结论性数字就用 stat
- 内容具体、专业、有信息量, 禁止空话套话; 中文输出
- 每页把 1-3 个最关键的术语/数字用 **词** 包起来(会渲染为强调色, 课件级标注); bullets 子项可用两个空格开头表示二级缩进

## 用户需求
%s"""


def _clean_json(txt):
    txt = txt.strip()
    if txt.startswith("```"):
        txt = txt.split("```")[1]
        txt = txt[4:] if txt[:4].lower() == "json" else txt
    i, j = txt.find("{"), txt.rfind("}")
    if i < 0 or j < 0:
        raise ValueError("响应无JSON: %.200s" % txt)
    return txt[i:j + 1]


def _make_illustration(block, out_png, spec):
    """
    v1.4 语义路由(凛倾: "配图太通用, AI完全不联网搜索下载"——根因是路由缺失):
      style=="photo"        → 联网 Commons 搜真实照片下载 → 失败降插画
      style=="diagram"      → AI SVG 画示意图(架构图/流程图 unDraw 根本没有, 通用人物图顶替=之前的病)
      style=="illustration" → unDraw 检索染色(缺省)
    每级失败自动降下一级, 最终降 AI SVG。
    """
    import style_packs as _sp
    import themes
    tname = (spec.get("meta", {}) or {}).get("theme")
    th = _sp.resolve_style(tname) or themes.resolve_theme(tname)
    accent = th.get("accent_color") if th else None
    q = block.get("query") or ""
    subject = block.get("placeholder") or q
    style = (block.get("style") or "illustration").lower()

    if style == "photo" and q:
        hit = asset_lib.get_photo_commons(q, out_png.replace(".png", ".jpg"))
        if hit:
            return hit
    if style == "diagram" and subject:
        # v1.4修: diagram 失败禁降 unDraw——"三层架构"配通用人物图(实拍)=错图比占位更误导,
        # AI 加试一次后诚实退占位框
        hit = gen_image.generate_illustration(subject, out_png, retries=3)
        return hit  # None=占位框
    if q:
        hit = asset_lib.get_illustration_png(q, out_png, accent_hex=accent)
        if hit:
            return hit
    return gen_image.generate_illustration(subject, out_png) if subject else None


ASCII_REVIEW_PROMPT = """你是幻灯片结构审查者。下面是你此前规划的 deck 渲染出的结构字符画(框线=区块边界, ██=标题, [图:]/[图表:]=视觉元素占位)。
逐页检查: 有没有某页一侧大片空白/区块比例失衡/视觉主角缺失/相邻页版式雷同/分隔不清晰。
若结构没问题, 只输出两个字: OK
若需要修改, 输出修改后的【完整 spec JSON】(结构与原 spec 相同, 只输出 JSON 不解释)。

## 原 spec
%s

## 结构字符画
%s"""


def _ascii_self_review(spec, base_dir):
    """
    v1.3 字符画自审环(凛倾原始流程"字符画→排版→算法修正→重新细化"的细化步复位):
    spec→solve→字符画→喂回 flash 结构检查→有修改则用新 spec。一轮, 失败不阻断。
    """
    import solver as _solver
    import ascii_view as _av
    try:
        lay = _solver.solve(json.loads(json.dumps(spec)), base_dir=base_dir)
        art = _av.render_ascii(lay)
        raw = gen_image.generate_text(
            ASCII_REVIEW_PROMPT % (json.dumps(spec, ensure_ascii=False), art),
            timeout=240, model=gen_image._load_cfg().get("spec_model"))
        if raw.strip().upper().startswith("OK"):
            return spec, "OK"
        new_spec = json.loads(_clean_json(raw))
        if new_spec.get("slides"):
            return new_spec, "revised"
    except Exception as e:
        return spec, "skip:%.80s" % e
    return spec, "OK"


def _llm_resolve_factory():
    """
    v1.3 回程闭环 LLM 决策(resolve_fn 钩子落座, "几何归算法,取舍归AI"补全):
    溢出信号交 flash 出取舍(精简/拆页/换region/删次要), 失败返回 None→确定性策略兜底。
    """
    def _resolve(spec, signals):
        try:
            raw = gen_image.generate_text(
                "你规划的幻灯片有区块放不下(溢出信号如下)。修改 spec 解决: 可以精简要点文字、"
                "拆分页面、把溢出块换到更宽的 region、或删除次要内容。只输出修改后的完整 spec JSON。\n\n"
                "## 溢出信号\n%s\n\n## 当前 spec\n%s" % (
                    json.dumps(signals, ensure_ascii=False),
                    json.dumps(spec, ensure_ascii=False)),
                timeout=240, model=gen_image._load_cfg().get("spec_model"))
            new_spec = json.loads(_clean_json(raw))
            return new_spec if new_spec.get("slides") else None
        except Exception:
            return None
    return _resolve


def make_deck(user_request, out_dir, animate="fade", with_bg=True, max_retry=1,
              doc=None, use_search=False, pages="5-7", prompt_file=None,
              ascii_review=True, llm_resolve=True):
    """
    需求进 → deck.pptx 出。返回 pipeline.run 的结果 dict + spec 路径。
    v1.1: doc=长文档; use_search=联网grounding; pages=页数。
    v1.3: ascii_review=字符画自审环(结构闸); llm_resolve=溢出取舍交LLM(确定性策略兜底)。
    """
    os.makedirs(out_dir, exist_ok=True)
    # v1.2 A/B: prompt_file 指定替换版提示词(如 prompts/spec_prompt_v2.txt), 缺省用内置 v1
    tpl = SPEC_PROMPT
    if prompt_file:
        tpl = open(prompt_file, encoding="utf-8").read()
    prompt = tpl % user_request
    prompt = prompt.replace("总页数 5-7 页", "总页数 %s 页" % pages)
    if doc:
        prompt += ("\n\n## 素材文档(基于它做内容, 提炼真实信息, 不要编造该项目没有的功能)\n"
                   + doc[:30000])
    if use_search:
        prompt += "\n\n(可联网搜索补充相关背景/对比数据, 但素材文档是第一事实来源)"
    spec = None
    last_err = None
    for attempt in range(max_retry + 1):
        raw = gen_image.generate_text(prompt, timeout=240, use_search=use_search,
                                      model=gen_image._load_cfg().get("spec_model"))
        try:
            spec = json.loads(_clean_json(raw))
            assert spec.get("slides"), "无slides"
            break
        except (ValueError, AssertionError, json.JSONDecodeError) as e:
            last_err = e
            spec = None
    if spec is None:
        raise RuntimeError("flash 出 spec 失败: %s" % last_err)

    # v1.3 字符画自审环(结构闸, 图像生成之前——结构改了插图才不白做)
    if ascii_review:
        spec, verdict = _ascii_self_review(spec, os.path.abspath(out_dir))
        print("[字符画自审]", verdict)

    # v0.8.1: 背景×2 + 插图×N 互不依赖 → 线程池并行(原串行6-8次LLM调用=主要耗时)
    from concurrent.futures import ThreadPoolExecutor
    meta = spec.get("meta", {}) or {}
    bg_prompt = meta.pop("bg_prompt", None)
    content_pattern = meta.pop("content_pattern", None) or meta.pop("content_bg_prompt", None)
    jobs = []
    with ThreadPoolExecutor(max_workers=5) as ex:
        if with_bg and bg_prompt:
            jobs.append(("cover_bg", None,
                         ex.submit(gen_image.generate_svg_png, bg_prompt,
                                   os.path.join(out_dir, "bg_cover.png"))))
        if with_bg and content_pattern:
            # v1.1 内容页背景=hero-patterns纹理(秒级确定性, 替代AI现场画的20-40s+方差)
            import themes as _th
            _t = _th.resolve_theme(meta.get("theme"))
            _accent = (_t or {}).get("accent_color", "CADCFC")
            jobs.append(("content_bg", None,
                         ex.submit(asset_lib.get_pattern_png, content_pattern,
                                   os.path.join(out_dir, "bg_content.png"),
                                   _accent, "FFFFFF", 0.08)))
        made = 0
        for sl in spec["slides"]:
            for b in sl.get("blocks", []):
                if b.get("kind") == "image" and not b.get("src") and made < 3:
                    # v1.1修: 文件名带枚举序号——flash 出重复block id时并发临时文件互删(实拍WinError2)
                    jobs.append(("ill", b, ex.submit(_make_illustration, b,
                                 os.path.join(out_dir, "ill_%d_%s.png" % (made, b.get("id", "x"))), spec)))
                    made += 1
        for tag, blk, fut in jobs:
            try:
                path = fut.result()
            except Exception as e:
                print("[%s 跳过]" % tag, str(e)[:100])
                continue
            if not path:
                print("[%s 质检不过, 退占位]" % (blk or {}).get("id", tag))
                continue
            path = os.path.abspath(path)
            if tag == "cover_bg" and spec["slides"] and spec["slides"][0].get("type") == "cover":
                spec["slides"][0]["bg_image"] = path
            elif tag == "content_bg":
                meta["bg_image"] = path
            elif blk is not None:
                blk["src"] = path

    spec_path = os.path.join(out_dir, "spec_generated.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)

    # v1.3: 溢出取舍交 LLM(resolve_fn 落座); LLM 失败时 pipeline 内部确定性策略兜底
    result = pipeline.run(spec_path, out_dir=out_dir, animate=animate,
                          resolve_fn=_llm_resolve_factory() if llm_resolve else None)
    result["spec"] = spec_path
    return result


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    req = sys.argv[1] if len(sys.argv) > 1 else "给一家准备开业的社区咖啡店做商业计划汇报：定位、目标客群、首年营收预测、成本结构、开业推广计划"
    r = make_deck(req, os.path.join(HERE, "works", "e2e_test"))
    print("spec:", r["spec"])
    print("pptx:", r["pptx"])
    print("信号:", json.dumps(r["signals"], ensure_ascii=False))
    if r["resolve_log"]:
        print("闭环:", json.dumps(r["resolve_log"], ensure_ascii=False))
