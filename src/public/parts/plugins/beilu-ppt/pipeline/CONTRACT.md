# ppt_ascii_pipeline_v0 接口契约（主AI定稿，各模块必须严格遵守）

## v3 场景图渲染架构（2026-07-17 定稿）

**链路**: spec → spec_norm(归一) → solver(文本几何, 保留) → **compose.py(视觉决策唯一产地)**
→ **scene 场景图 IR**(5 图层显式 z 序 × 8 原语: text/shape/line/gradient/image/table/chart/group,
tokens.py 设计令牌单源) → **pptx_paint/png_paint 薄画笔**(零测量零决策, 按 z 照画) + ascii_view(layout 草稿)。
- 组装铁律: 文字永远 text 原语(runs 携带加粗/色/字号——`**` 强调在 IR 层落位), 装饰永远
  shape/gradient 原语, 位图只出现在 image 原语。**每个元素都是组件 → 结构上不可能不可编辑**。
- png_view.py / pptx_out.py 已删除(双实现灭绝)。视觉特性改动只改 compose 一处。
- `type:"html"` 整页已废除: spec_norm._migrate_html_page 迁 bg_html+`html_page_deprecated` 信号;
  full_bleed 语义随之移除; _resolve_page_markup 只剩 bg_html 装饰单通道(上限 16)。
- 新页型: `hero`(kicker/title/subtitle/tagline/align, 无 deco 自动按主题配深底装饰) /
  `quote`(text/attribution)。新装饰: slide.deco=[gradient_bg|circle|rect|line]（参数化, solver 钳幅）。
- 新块: `kind:"widget"`（badge{text}|progress{value,label}|rating{value,label}——纯形状+文字组件）。
- 多步工作流 op（main.mjs）: `outline`(内容工件落盘 outline.json+stage, 零 python) →
  draft → generate → `page`(name+page=页id, 标签体=单页 slide JSON, 替换重渲, 附件只回该页 PNG+pptx)。
- **deco art 小图组件（v3.1, 凛倾 0717 定案: 前端代码只用于美化小组件转小图, 整页转换不做——编辑与转换问题大）**:
  `{"type":"art","html":"<svg/div 小组件>","x","y","w","h"}` → pipeline._resolve_deco_art 在最终
  layout 上经 render_markup_png(transparent=True, Chrome --default-background-color=00000000)
  渲透明小 PNG → compose 以 image 原语放装饰层。文字禁进 art; 失败=该装饰缺省+信号, 不阻断;
  上限 MAX_DECO_ART_PER_DECK=12。
- 铁律（凛倾 0717）: 代码只做后台管道——不审查 CoT/输出内容、零词库零内容识别;
  信号只报操作错误(符号/格式/流程/几何)。内容质量检测点=AI 自审(提示词层)+用户审查(outline/draft 闸)。

设计哲学：AI只给语义/拓扑（零坐标）→ 算法做几何（真实字体度量）→ 渲染器保证对齐。
单源原则：**solver 是唯一做换行和坐标计算的地方**。三个渲染器（ascii/png/pptx）只消费
layout.json 里已算好的 lines 和坐标，禁止自己重新换行/重新测量。

## 画布常量（所有模块一致）

- 幻灯片：16:9，宽 13.333 英寸 × 高 7.5 英寸
- 字体文件：零路径依赖——env `BEILU_PPT_FONT` 优先，否则按平台探测常见中文字体
  （Windows 雅黑/黑体、macOS 苹方、Linux Noto/文泉驿，见 solver.py `_resolve_font_path`），
  找不到 fail-loud；pptx 里字体名 `微软雅黑`（度量与渲染同源单源）
- PIL 度量约定：`ImageFont.truetype(path, size=font_pt)` 时 1pt=1px，故 宽度英寸 = textlength_px / 72
- 行高：`font_pt * 1.35 / 72` 英寸；安全边距：文本可用宽度按盒宽的 92% 计算
- 字符画网格：100 列 × 30 行（1列=0.13333英寸，1行=0.25英寸）

## 文件与分工

| 文件 | 职责（v3 现行） |
|---|---|
| spec_norm.py | spec 归一（值域/别名/字符净化/html 迁移/deco·widget 容错） |
| solver.py + solver_blocks.py | spec → layout（文本几何/页型/复合块求解+溢出信号） |
| tokens.py | 设计令牌单源（图层 z/字阶/间距/色彩语义） |
| compose.py | layout → scene 场景图（视觉决策唯一产地） |
| scene.py | 场景图 IR（8 原语构造/校验） |
| pptx_paint.py / png_paint.py | scene → 原生 pptx / 预览 PNG（薄画笔, 零决策） |
| ascii_view.py | layout → 框线字符画（draft 草稿） |
| pipeline.py | 编排+容错+回程信号（含 art 渲染/装饰层/素材解析） |
| （png_view.py / pptx_out.py） | v3 已删除——双实现由 compose+双画笔取代 |

各模块只写自己的文件。每个 .py 必须带 `if __name__ == "__main__":` 自测入口（读同目录
spec_demo.json / layout_demo.json 或内置最小样例），跑 `python <file>.py` 能自证。

## spec.json（输入：AI语义层，零坐标）

```json
{
  "meta": {"title": "整套deck标题", "font": "微软雅黑"},
  "slides": [
    {
      "id": "s1",
      "title": "本页标题",
      "blocks": [
        {"id": "b1", "kind": "bullets", "items": ["要点一", "要点二"], "region": "left", "weight": 2},
        {"id": "b2", "kind": "image", "placeholder": "架构图", "region": "right", "weight": 1},
        {"id": "b3", "kind": "text", "text": "一段说明文字", "region": "bottom", "weight": 1}
      ]
    }
  ]
}
```

- kind ∈ `bullets` | `text` | `image`（image 是占位框，只有 placeholder 标注文字）
- region ∈ `left` | `center` | `right` | `top` | `bottom` | `full`
- weight：同区多块时的空间占比，默认 1

### v0.1 扩展（可选字段，缺省=v0 行为）

- image block 可带 `"src": "<图片路径>"`（绝对或相对 spec 所在目录）。有 src 且文件存在→渲染真图
  （png_view 等比缩放居中贴入格子灰底上；pptx_out 用 add_picture 等比缩放居中）；无 src 或文件
  不存在→按 v0 占位框渲染（不报错，字符画层永远只画占位框+标注）。
- meta 可带 `"theme"`：`{"title_color":"1F2937","body_color":"333333","bg_color":"FFFFFF","accent_color":"2563EB"}`
  hex **不带 #**（呼应 pptx 生态踩坑清单）。缺省=黑字白底。消费方式：png_view 背景/文字用对应色，
  bullets 的 `•` 可用 accent_color；pptx_out 同理（背景色画整页底 rect 或 slide background）。
  ascii_view 不消费颜色。
- solver 透传：layout 顶层加 `"theme": {...}`（原样透传或 None）；image box 加 `"src"`（解析为绝对路径或 None）。

### v0.2 扩展

**kind=chart（原生可编辑图表）**：block 形如
`{"id":"c1","kind":"chart","chart_type":"bar"|"line"|"pie","title":"标题","categories":["Q1","Q2"],"series":[{"name":"系列A","values":[1,2]}],"region":"right","weight":1}`
- solver：chart 与 image 同法占格子（不缩放），box 透传 chart_type/categories/series/title，
  lines 固定 `["[图表: <title>]"]`，font_pt=14
- ascii_view：按占位框渲染 lines（不画数据）
- png_view：画简易示意——bar=纵条、line=折线、pie=扇形，用 theme accent_color 或默认蓝，
  不追求精确，只为预览体感；顶部画 title
- pptx_out：python-pptx 原生 `add_chart`（XL_CHART_TYPE.COLUMN_CLUSTERED/LINE/PIE +
  CategoryChartData），产出可编辑图表；图表标题用 chart.chart_title

**回程闭环（pipeline）**：`run(spec, auto_resolve=True, max_iter=3, resolve_fn=None)`
- 确定性降级策略（无 LLM 时）：
  - `reduce_items`（bullets 溢出）：砍掉该 block 尾部 1 条 item 后重 solve，循环至放下或只剩 2 条
  - `split_slide`（bullets 溢出且 items>=4）：items 对半拆成两页，后页标题加"（续）"
  - text 溢出 / widen_region：不自动修，保留 signal 供上游（LLM/人）决策——诚实降级
- `resolve_fn(spec, signals) -> new_spec_or_None`：外部钩子，传入则替代确定性策略（接 LLM 的位置）；
  返回 None 表示放弃修复
- 每轮迭代记录到返回值 `"resolve_log"`：[{iter, signal, action, detail}]

**对比度自检（pipeline）**：theme 存在时按 WCAG 相对亮度算对比度，
body_color vs bg_color < 4.5 或 title_color vs bg_color < 3.0 → 产出
`{"type":"contrast_warning","pair":"body/bg","ratio":2.1,"min":4.5}` 进 signals（只警告不阻断）。

### v0.3 扩展

**动画后处理 animate.py**（python-pptx 不支持动画，走 zip 解包→注入 `<p:timing>`→重打包）：
- `add_animations(pptx_path, mode="fade") -> pptx_path`（原地或另存，接入 pipeline 为可选步骤
  `run(..., animate=None|"fade"|"wipe")`，默认 None=零行为变化）
- 每页 mainSeq 里逐 shape 一个 clickEffect 入场动画（fade: presetID=10 filter=fade；
  wipe: presetID=22 filter=wipe(fromBottom)），结构=探针验证过的
  tmRoot par > seq(mainSeq, prevCondLst/nextCondLst 带 sldTgt) > 每效果三层 par 嵌套 +
  set(style.visibility→visible) + animEffect(transition="in")
- **spid 必须来自真实 shape**：用 python-pptx 遍历 slide.shapes 取 shape_id（spTree 根 cNvPr id=1
  不是 shape，探针实证会挂出一个空 shape 效果），标题 shape 排第一个出场
- XML 构建禁字符串拼接嵌套标签，用 lxml etree 建树（探针字符串版曾少闭合根 par 直接坏文件）
- 幂等：slide XML 已有 `<p:timing>` 则跳过该页
- 验证标准：python-pptx 重开 + minidom 良构 + （若本机可用）PowerPoint COM 开文件断言
  TimeLine.MainSequence.Count == shape数 且 EffectType 符合预期，用完 Close+Quit

### v0.5 扩展（吸收 anthropics/skills pptx SKILL.md）

- **theme 预设**：meta.theme 可为字符串预设名（themes.py PRESETS，10组官方色板映射四色），
  dict 仍支持；solver 用 themes.resolve_theme 解析后放 layout["theme"]（渲染器/对比度检查
  统一读 layout["theme"]——单源）；未知预设名 → layout.theme=None + pipeline 发
  `{"type":"unknown_theme","name":...}` 信号
- **标题字号校准**：TITLE_SIZES 32→[36,32,28]（官方规范 36-44pt bold）
- **kind=stat 大数字 callout**（官方 Data display: 60-72pt 大数字+小标签）：
  block `{"kind":"stat","value":"40%","label":"处理耗时下降","region":...}`
  solver 占格，box 带 font_pt=60(value 超宽逐级降 52/44/36)、
  label_pt=14、lines=[value,label]；png/pptx 渲染：value 大字加粗 accent 色水平居中，
  label 14pt body 色居中其下；ascii 天然占位框
  - v1.6: label 进量测——solver 按 STAT_LABEL_PT 实测断行产 box["label_lines"]
    （lines=[value,label] 原契约不动，label_lines 是渲染层新字段），fit 循环高度按真实
    label 行数算，放不下→overflow 信号 suggestion=widen_region_or_shorten_label；
    png_view 逐行渲染 label_lines 且居中偏移钳内（禁负偏移切头）；_stack_column 里
    stat 同 text/table 收缩为实测高（不再拿满 weight 高留大空白）
- **QA 流程资产**：官方 visual QA prompt 存 qa_prompt.md，真实产出时子代理（新鲜眼睛）
  按它读图挑错，至少一轮 fix-and-verify

### v0.6 扩展（绚丽化: AI 生成背景）

- **gen_image.py**：Gemini 网关（api_config.json 配置, key 不进代码）出 SVG →
  Chrome headless 截图 → PNG。generate_svg_png(prompt, out_png, w, h)。
  网关无位图模型（503 实测），SVG 是文本模型强项 = 正确路线。
- **bg_image**：meta.bg_image = 全 deck 默认背景图；slide.bg_image = 页级覆盖（"none"=该页关）。
  路径相对 spec 目录。solver 解析绝对路径：layout 顶层 bg_image + 每 slide bg_image
  （null=继承顶层）。pptx_out：add_slide 后**立即** add_picture(0,0,全宽高)（先加=z序最底）；
  png_view：先贴底图（拉伸满画布）再画其他。ascii 不消费。
- **cover 三明治配色**：theme 可带 cover_title_color（预设库已配 FFFFFF/浅色）。
  solver 给 cover 页透传 "type":"cover"；渲染器对 cover 页的文字用 cover_title_color
  （深底背景上深色标题不可读——对比度问题的结构性解法）。

### v1.3 扩展（主题适配: 风格包+分隔页, 参照 frontend-slides/academic-pptx skill）

- **风格包**（style_packs.py 三包: bold_signal/swiss_modern/paper_ink）: meta.theme 也可填风格包名。
  solver 用 style_packs.resolve_style→兜底 themes.resolve_theme 解析, layout["theme"] 携带扩展键:
  `cover_bg_color`(cover无bg_image时的纯色深底, 根治白字白底), `big_page_number`(bool, 右上超大
  页码 01/02, 44pt accent 20%透明感=淡色), `divider_style`("band"=accent色带横贯中部反白字 |
  "card"=左侧大色块), `card_style`("tint"=v1.2色卡|"line"=无底色仅accent左竖条+块间细分隔线),
  `title_rule`(bool, 标题下全宽0.5pt细rule, 编辑排版惯例——非官方禁忌的短粗装饰线)。
  所有扩展键缺省=v1.2 行为不变。
- **divider 章节分隔页**: slide `{"id","type":"divider","number":"02","title":"章节名"}`——
  solver 产两个 box: kind="divider_num"(number, 96pt) + kind="divider_title"(章节名, 34pt),
  几何居中(同 cover 手法)。渲染端按 divider_style 画底饰。ascii 端占位渲染即可。
- **图文搭配强化**: chart box 新增可选 "caption"(一句图注)——solver 透传, 渲染端画在 chart 下方
  11pt 灰字居中。spec 的 chart block 可带 caption 字段。——该页忽略 blocks 常规布局：
meta_title 44pt 加粗横向居中、垂直 40% 处；slide.title 作副标题 20pt 居中在其下 0.3"；
无 blocks 要求。boxes 的 kind 分别为 "title" 与 "text"。ascii/png/pptx 无需改（消费的还是普通 box）。

### v1.5 扩展（kind=table 原生可编辑表格, 业界参照: python-pptx add_table + 表头强调/斑马纹惯例）

**spec**：`{"id":"t1","kind":"table","headers":["列1","列2"],"rows":[["a","b"],["c","d"]],"caption":"可选图注","region":"full","weight":1}`
- headers 一行表头；rows 数据行二维数组；短行右侧补空串对齐列数
- solver：字号降级链 14→12→10；列宽按"列内最宽单元格实测宽+内边距"比例分配盒宽
  （SAFE_W_RATIO 内），单元格在列宽内换行（每格最多 3 行，超出截断加 …）；
  行高 = 该行最高单元格行数 × 行高 + 垂直内边距；总高超盒高 → overflow=true +
  signal `{"suggestion":"split_table"}`。box 携带：font_pt / col_w_in[] / row_h_in[]
  （首元素=表头行）/ headers[]（原文）/ rows[][]（原文）/ cell_lines[][][]（solver
  换行后的最终行，png 消费）/ lines（字符画预览行：表头+─┼─分隔+数据行，ascii 消费）
- ascii_view：零改动——lines 已由 solver 排好列对齐的表格字符画
- png_view：表头行 accent 色底反白加粗；数据行白/accent-tint(6%) 斑马纹；行底 0.5px
  浅灰分隔线；单元格文字消费 cell_lines（不重新换行）
- pptx_out：python-pptx 原生 `add_table`（可编辑），逐列设 width、逐行设 height；
  表头单元格 accent 填充+白字加粗，数据行白/tint 交替填充（斑马纹惯例，不画竖线）；
  单元格喂 headers/rows **原文**（编辑性优先——solver 的 row_h 已按预估换行留高，
  PowerPoint 原生 wrap 与预估可能有 ±1 行误差，行高只会被内容撑大不会截字）；
  caption 同 chart 惯例画表下方 11pt 灰字
- **回程闭环**：pipeline `_apply_default_strategy` 对 table overflow 做 split_table
  （rows 对半拆到续页，表头复制，同 bullets split_slide 续页机制）

### v1.6 扩展（AI 自绘配图 + stat label 量测）

- **image 块自绘标记**：`{"kind":"image","svg":"<svg ...>","region":...}`（`html` 键同义支持）——
  spec 作者本身是 LLM，自绘=零额外模型调用。`_resolve_spec_assets` 里自绘优先于 query 检索：
  asset_lib.render_markup_png 经既有 Chrome 截图通路出 PNG → 写回 b["src"]，计入
  MAX_ASSETS_PER_DECK；`<svg>` 片段居中 contain 嵌画布，完整 `<html>/<!DOCTYPE>` 原样整页截。
  无 Chrome/空标记 → 占位框优雅降级（resolve_log 记 asset_miss）。--screenshot 是同步一次性
  截图，不等异步 JS——引导侧约定只用静态 SVG/HTML+CSS。diagram style 的 asset_skip 提示
  已改指向本字段。
- **stat label 量测**：见上文 v0.5 stat 条目内 v1.6 补注（label_lines / 收缩 / 钳制）。

### v1.7 扩展（容错四域: 符号/算法/转行/配图）

- **符号容错（JS 侧, beilu-ppt main.mjs）**：spec 严格 JSON.parse 失败才进修复链——字符串感知
  扫描（全角结构符/智能引号/单引号定界/注释/尾逗号只在字符串外动，内容中文标点绝不改写）→
  夹带文字抠 JSON（PPTAgent 范式）→ 截断补闭合（栈闭合+值边界回退）。修复命中项+引导
  （ppt.repair_note, injectTexts 可配）回喂 AI 自纠。
- **算法容错（solver.normalize_spec, pipeline.run 单一调用点）**：kind/region/style/type 小写
  +别名归位（bullet/img/graph/middle 等）；slides/blocks 非对象丢弃+信号；未知 region 回退
  center+信号；chart/table/bullets 数据域强制归位（坏 series 曾穿透渲染层 AttributeError 炸
  全 deck），无效降级 text+invalid_data 信号；emoji/图形符号剔除（1F000-1FAFF+2600-27BF+
  2B00-2BFF，微软雅黑无字形且 PIL 无回退→豆腐块）+emoji_stripped 信号。norm 信号不进回程
  闭环（策略修不了值域病, 防空转），闭环后并入 signals。
- **逐页故障隔离（solver.solve）**：单页求解异常→错误占位页+slide_error 信号，不炸全 deck。
- **转行贯通**：png_view title/divider band 全行渲染（此前 lines[0]+截断丢 solver 断行产物）；
  cover 主/副标题、divider 章节名 solver 断行+盒高联动；divider card 是"渲染器不重新换行"
  契约的唯一豁免点（1/3 柱宽≠solver 全宽断行基准→渲染端按柱宽重断+字号纵向适配）。
- **配图容错**：src 支持 http(s) URL（限时 20s/限量 15MB/类型校验/UA 必带, 失败占位框; svg
  下载件经 Chrome 转位图）；自绘标记纯色空白检测（PIL getextrema）判 miss；无 "<" 判 miss。

### v2.0 扩展（流程图重做 P0: 平台化+两段式工作流）

- **draft 草稿**：pipeline.run(draft=True)——只跑 normalize+solve+ascii（秒级, 零 Chrome/PNG/pptx），
  凛倾流程①"字符画定位+内容→用户审查"；JS 侧 action="draft"，回喂走 ppt.draft_instruction。
- **阶段状态机**：deck 目录 stage.json {stage: draft|final}（JS 侧写）；load/list 读侧报阶段；
  回炉链=load→改 spec→draft 重审→过稿 generate 同名覆盖。
- **页级 AI 代码**（_resolve_page_markup, 在块级素材前）：slide type="html"+html/svg=整页自由页；
  slide.bg_html=装饰背景层。产物走 bg_image 消费链；上限 MAX_PAGE_MARKUP_PER_DECK=8；
  失败/空白/无 Chrome→log 降级。自由页打 full_bleed：solver 空 title 不产标题框，
  png/pptx 双端跳大页码/页脚（整页留给 AI 设计）；pptx 侧自由页=整页图不可编辑（权衡在提示词明示）。

### v2.1-v2.2 扩展（字体接线 / 准度体检 / 画布参数化）

- **meta.font**（v2.1）: solver.set_font 唯一改点——覆盖层 fonts{名:路径} > FONT_ALIASES 内置 >
  直接文件路径；度量文件与 pptx 名同步切换（png_view 用时读 solver.FONT_PATH, 禁 import 快照,
  缓存键含路径）；未命中退默认+font_fallback 信号。bullet 符号随字体字形实测选（U+2022 不在
  GB 字库→楷体/宋体豆腐, _refresh_bullet 逐级降 •→●→·→"-", wrap_bullet/png 前缀单源）。
- **渲染准度体检**（v2.1, pipeline._check_markup_png）: AI 代码渲染产物查尺寸偏差+边线纹理
  方差判裁切（>900≈内容顶边被裁; 角点参照法会被设计性边框骗, 已弃用）。页级 page_markup_warn /
  块级 asset_markup_warn 进 resolve_log 回喂。
- **meta.canvas**（v2.2）: solver.set_canvas 唯一改点——预设 16:9|4:3|9:16|a4 / "宽x高"英寸 /
  {w_in,h_in}, 值域 5-30in, 非法退 16:9+canvas_fallback 信号；TITLE_W 派生同步重算；
  png 画布/ascii 网格(密度 0.13333in/列 0.25in/行 不变)/自由页渲染尺寸/体检预期全从
  layout 尺寸派生, pptx 端本就消费 layout 尺寸。pipeline.run 在页级渲染前先行 set_canvas
  （信号由 solve 单点收集防重复）。

### v2.6 扩展（可编辑性收口: ** 全覆盖 / diagram 原生流程图 / 空页根治 / 文件拆分）

- **`**词**` 强调全文本域覆盖**：`solver._extract_emphasis` 是统一入口——bullets/text 之外，
  标题（`_fit_title` 回传 accents）、封面主/副标题、divider、表格单元格（`solver_blocks._norm_table`
  剥标记并汇入 box["accents"]）、stat value/label、chart/table 标题与 caption、image placeholder、
  meta_title（页脚）全部剥标记；渲染端 pptx `_fill_cell`/`_fill_textbox` 与 png 标题/表格按 accents
  画加粗+accent 色（表头不染——本就 accent 底反白）。量测与渲染同吃纯文本（先剥再测）。
- **kind=diagram 原生可编辑流程图**：spec
  `{"kind":"diagram","nodes":[{"id","label","sub"?}...],"edges":[[src,dst,label?]...],"direction":"lr"|"tb"}`。
  归一在 spec_norm._norm_diagram（字符串节点收编/无效降级 text+invalid_data 信号；别名 flow/flowchart/process）。
  solver_blocks._diagram_box：节点等分主轴（gap 0.45"）、主标签字号降级 14→12→10（≤3行）、
  sub 10pt（≤2行）、节点高统一取最高、整排居中；edges 缺省按 nodes 顺序成链；放不下 →
  overflow+reduce_nodes_or_direction_* 信号。pptx 端 `_add_diagram`：RECTANGLE(tint底+accent描边)
  +内嵌文字+STRAIGHT 连接线（a:tailEnd 注入箭头端点, OOXML 20.1.8.58）+边标签小 textbox——全部原生可编辑；
  png 端 `_draw_diagram` 同源预览（圆角矩形+三角箭头）；ascii 走通用 lines（流程摘要行）。
- **空页根治（page markup）**：上限 8→16 且两轮渲染——先 type=html 内容页后 bg_html 装饰层
  （超限牺牲装饰不牺牲内容页）；自由页渲染失败/超限一律清 type 按普通页排，整页无 title/blocks 时
  注入占位 text 块（杜绝纯空白页），resolve_log 记 page_markup_fallback。
  自由页协议改为"文字与装饰分离"：html 只承载装饰，正文文字走 title/blocks 原生叠加（提示词层约定）。
- **文件拆分（≤1000 行）**：normalize 域拆 `spec_norm.py`；table/stat/diagram 块求解拆
  `solver_blocks.py`（`import solver` 运行时 live 引用度量函数）；solver 回绑保持 `solver.*` 消费面
  不变；solver 顶部 `sys.modules.setdefault("solver", ...)` 防直跑 `python solver.py` 双实例。

## 布局算法（solver 的确定性规则）

1. 标题带：y=0.35"，高 1.0"，左右边距 0.6"，字号 32pt（超宽自动降到 28/24）
2. bottom 区：贴底带，高度=内容实测高度+0.3"，最大 1.2"
3. top 区块：紧跟标题带下方
4. 剩余中部区域：left/center/right 各列按"列内块的 weight 总和"横向分宽，列间距 0.3"
5. 同列多块：纵向按 weight 分高，块间距 0.25"
6. full：独占中部整宽
7. 文本适配：bullets/text 从 18pt 起，逐级降 16→14pt；14pt 仍放不下 → overflow=true 并发信号
8. image 占位框不缩放，占满所给格子

## layout.json（solver 输出，渲染器唯一输入源）

```json
{
  "slide_w_in": 13.333, "slide_h_in": 7.5, "font": "微软雅黑",
  "meta_title": "整套deck标题",
  "slides": [
    {
      "id": "s1",
      "boxes": [
        {"id": "s1_title", "kind": "title", "x": 0.6, "y": 0.35, "w": 12.13, "h": 1.0,
         "font_pt": 32, "lines": ["本页标题"], "overflow": false},
        {"id": "b1", "kind": "bullets", "x": 0.6, "y": 1.55, "w": 7.8, "h": 4.4,
         "font_pt": 18, "lines": ["• 要点一", "• 要点二"], "overflow": false},
        {"id": "b2", "kind": "image", "x": 8.7, "y": 1.55, "w": 4.0, "h": 4.4,
         "font_pt": 14, "lines": ["[图: 架构图]"], "overflow": false}
      ],
      "signals": []
    }
  ]
}
```

- 坐标单位一律英寸（float），原点左上
- `lines`：solver 用 PIL 实测换行后的最终行数组；bullets 每条以 `• ` 开头，续行以两空格缩进
- image 的 lines 固定一条 `[图: <placeholder>]`
- signals 元素：`{"block_id": "b1", "type": "overflow", "needed_h": 3.2, "avail_h": 2.5, "suggestion": "reduce_items"}`
  suggestion ∈ `reduce_items` | `split_slide` | `widen_region`

## 渲染器要求

**ascii_view.py**：`render_ascii(layout: dict) -> str`（全部页拼接，页间空行+页码行）。
每个 box 画 `┌─┐│└┘` 框，框内嵌 lines（截断加 `…`）；title 用 `██ ` 前缀不画框；
坐标映射：col = round(x/13.333*100)，row = round(y/7.5*30)。overflow 的框右上角标 `!`。

**png_view.py**：`render_png(layout: dict, out_dir: str) -> list[str]`（每页一张 preview_s<i>.png，
1280×720，白底黑框，用 msyh.ttc 按 font_pt 画 lines，image 占位画灰底+标注）。

**pptx_out.py**：`render_pptx(layout: dict, out_path: str) -> str`。python-pptx，空白版式，
每 box 一个 textbox（image 画浅灰填充矩形+标注文字）。text_frame.word_wrap=True，
auto_size 关闭，每条 line 一个 paragraph，字体名用 layout["font"]。EMU 转换用 pptx.util.Inches。

