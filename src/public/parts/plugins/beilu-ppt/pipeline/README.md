# beilu-ppt pipeline — 字符画 PPT 管线（插件内置）

AI 只写语义 spec（零坐标），算法做几何（真实字体度量换行），三渲染器单源消费：
spec.json → solver(layout.json) → ascii 字符画 / png 预览 / pptx。契约详见 CONTRACT.md。

## 依赖
- Python 3.10+，`pip install -r requirements.txt`（pillow / python-pptx / lxml）
- 一个中文字体：Windows 自动探测微软雅黑/黑体；其他平台自动探测 Noto/文泉驿，
  或设环境变量 `BEILU_PPT_FONT=/path/to/font.ttc`

## 可选增强（缺失自动降级，不影响核心生成）
- `BEILU_PPT_CHROME`：Chrome/Chromium 路径（SVG 插画/图标/背景纹理截图渲染；常见安装位自动探测）
- `BEILU_PPT_UNDRAW` / `BEILU_PPT_TABLER` / `BEILU_PPT_PATTERNS`：本地素材库目录（未配置=占位框）
- 以上四项也可在 beilu-ppt 插件设置里填（assetUndrawDir/assetTablerDir/assetPatternsDir/chromePath，
  经子进程 env 传导，管线侧契约不变）
- v1.5 起主链路（`<ppt_op>`）image block 带 `query` 自动走确定性素材解析：
  style=illustration(缺省)→unDraw / icon→Tabler / photo→Wikimedia Commons(联网,无网静默降级)；
  diagram 需 AI 出图仅 gen_spec CLI 路支持，主链路诚实占位框
- `api_config.json`：AI 出图与 gen_spec 独立 CLI 的网关配置（复制 api_config.example.json 填写；
  beilu 的 `<ppt_op>` 主链路不需要）

## beilu 接入
beilu-ppt 插件（../main.mjs）默认把 pipelineDir 指向本目录，AI 在 work/code 模式输出
`<ppt_op action="generate" ...>{spec}</ppt_op>` 即走 pipeline.run() 生成并回喂字符画预览。

## 第三方资源致谢（均为可选外挂素材，本仓库不内置）
- [unDraw](https://undraw.co) 插画（MIT）
- [Tabler Icons](https://tabler.io/icons)（MIT）
- [Hero Patterns](https://heropatterns.com)（MIT/CC BY 4.0，见其官网条款）
- 真实照片检索走 Wikimedia Commons 公开 API（CC 系授权，按图各自条款）
