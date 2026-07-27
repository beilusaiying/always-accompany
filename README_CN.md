<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-加入社区-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-点个_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
  &nbsp;
  <a href="beilu-presets_2026-02-23.json"><img src="https://img.shields.io/badge/📦_记忆预设-开箱即用-4CAF50?style=for-the-badge" alt="记忆预设"></a>
</p>

<p align="center"><a href="README.md">English</a> | 中文 | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a></p>

> 本项目由一名在校大学生独立完成全部设计、架构与开发，借助 AI 辅助编程，融合算法设计、仿生学原理、框架架构和逻辑思维等多方面能力。

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# 或 chmod +x run.sh && ./run.sh   # Linux/macOS
```

浏览器打开 `http://localhost:1314` → 设置 AI 服务源 → 导入角色卡 → 开聊。Deno 运行时会在首次启动时自动下载，无需手动安装。至少需要一个 AI API Key。应用内置完整 wiki 教程。

> **提示：** 首次启动会比较慢——运行时需要下载依赖并初始化数据库，请等待页面完全加载后再操作。之后的启动会快很多。

---

一套三层递归记忆（日→月→年归档，纯 JSON，260 年容量）+ 前置检索 AI（专职从记忆里找相关的，只把找到的交给回复 AI，两个各管各的）+ 分层上下文清理（清掉的只是不再发送，原文留着随时恢复）。这三件事咬合在一起，让 AI 不再受上下文窗口限制地记住你说过的每一句话。在此基础上，我们做了聊天/角色扮演、IDE 编程、工作模式（含 AI 做 PPT）、Live2D 桌宠（屏幕感知+游戏陪伴）、语音输入、Discord Bot、MCP 外部工具接入——所有入口共享同一套记忆，换个窗口 AI 依然认识你。正在优化的下一代检索引擎（21 节点纯算法管线，零 LLM 零网络，毫秒级，目标：句子级注意力）。

---

## 功能一览

<table>
<tr>
<td width="33%">

**💬 聊天 / 角色扮演**
![聊天界面](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE 编程模式**
![IDE编程](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 工作模式（AI 做 PPT）**
![work模式PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D 桌宠 + 屏幕感知**
![桌宠](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 L0–L5 六档权限闸**
![权限设置](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ 分层压缩 × 逐条可控**
![压缩机制](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 三层记忆**：热（每轮注入）/ 温（按需检索）/ 冷（深度归档），纯 JSON + 纯提示词驱动，零数据库
- **🎯 P1 前置检索**：专职小 AI 先找记忆再交给回复 AI，BM25 + 正则双引擎，检索可用免费模型
- **🗜️ 压缩系统**：三级层级（一键/按类型/逐条）× 四类颗粒度（对话/文件读取/系统注入/过程内容）+ AI 自主 `<contextClean>` 清理，全部可回溯
- **📊 10 张记忆表格**：结构化存储，AI 用 `<tableEdit>` 自动维护，实现信息隔离（角色不知道的事表格里就没有）
- **👑 提示词引擎**：5 段式消息结构 + TweakPrompt 三轮接管，宏变量 + 世界书动态注入（常驻/正则/动态三模式）
- **💻 IDE 级工作流**：VSCode 风格三栏，AI 直接读写文件，命令执行逐条审批
- **🔌 MCP 外部工具**：粘 JSON 接入，命令型默认拦下 owner 批准才启动，env 白名单防泄漏
- **🐾 桌宠 + 游戏陪伴**：Live2D / 图片包桌宠，三档隐私开关，自动截屏+主动搭话+频率自适应
- **🎙️ 语音输入**：本地模型转录，说话人区分+时间线，音频不出机器
- **🤖 跨平台 Bot**：Discord 部署，可视化管理 + 实时消息日志
- **🧩 22 个功能插件** + 用户级插件宿主 + 生态兼容（多种格式角色卡/预设/世界书导入）
- **🛡️ 数据全在本地**：删除进回收站可找回，多层自动备份 + git 回档
- **🌐 多语言**（中/英/日/繁）· **🔬 全栈诊断**（12 模块日志 + 一键打包）· **🎨 多套 CSS 主题**

---

## 详细机制

<details>
<summary><strong>🧠 三层递归记忆 — 为什么要分层</strong></summary>

全部历史扔进一个大池子，找的时候就慢——而且实验数据说了（[Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)），扔进去模型也未必看得到。按照人脑海马体的记忆形成机制和艾宾浩斯遗忘曲线的思路，我们把信息按时间距离分成三层：

```
🔥 热记忆层 — 每轮自动注入：用户画像 / 永久记忆 / 未完成任务 / 近期记忆
🌤️ 温记忆层 — 按需检索（最近 1 个月）：每日总结 / 临时归档 / 月度索引
❄️ 冷记忆层 — 深度检索（1 个月以上）：月度总结 / 历史日总结 / 年份索引
```

热层每轮只占 ~7,000–11,000 tokens（128K 窗口的 5–9%）。记忆衰减借鉴艾宾浩斯遗忘曲线：`score = weight × (1 / (1 + days × 0.1))`。纯提示词驱动——改归档策略、表格含义、检索风格，改提示词就行，不用动代码。

</details>

<details>
<summary><strong>🎯 P1 前置检索 AI — 为什么拆成两个 AI</strong></summary>

让回复 AI 自己在几百条历史里挑相关的，它既要找又要回复，注意力在两件事之间被稀释。把"找记忆"拆出来给一个专职小 AI：

```
用户发消息 → P1 检索 AI（<5K tokens，专注找）→ 精选记忆 + 当前对话 → 回复 AI（专注回复）
```

BM25 粗筛 + 正则精确匹配，最多 3 轮命中。检索用免费轻量模型即可，每次对话实际开销 ≈ 只有回复 AI 一次调用。P1 同时负责预设自动切换（冷却 5 轮防振荡）。

</details>

<details>
<summary><strong>🗜️ 上下文管理 — 压缩颗粒度 × 层级 × AI 自主清理</strong></summary>

AI 工作时会不断堆积过程性内容（反复读同一文件、过时搜索结果、旧工具结果）。我们的清理只是 hide——随时可恢复。

**AI 自主清理**：系统注入上下文占用信号（50% 建议 / 70% 警告 / 85% 紧急），AI 用 `<contextClean>` 指令自主瘦身。清前先落盘，清错可逆。

**用户精细管理**：三级层级（一键全量/按类型/逐条精挑）× 四类颗粒度（对话消息/文件读取逐条 token 账单/系统注入五类勾选/过程内容自动瘦身）。

缓存率实测（Opus + DeepSeek，含 AI 身份切换 + 自主压缩）：**75%–80%**。

![压缩面板](imgs/screenshots/compression-multi.png)

</details>

<details>
<summary><strong>🔬 自驱动 P1 — 正在优化的零 LLM 检索引擎</strong></summary>

AI P1 每轮要发 API 请求——有延迟、有成本、离线不能用。我们写了一条完整的纯算法管线（21 节点，~9,000 行），目标：毫秒级、零网络、句子级注意力。

**数据基础**：[SWOW 中文联想网络](https://smallworldofwords.org/) / [ConceptNet Numberbatch 300 维词向量](https://github.com/commonsense/conceptnet-numberbatch)（~30 万词）/ ConceptNet 中文关系图 / THUOCL 等多源词典。词库由 AI 联网搜索 + 2 天自审查获取，构建成本约为零。

**管线**：分词 → SWOW 联想发散（禁同义扩散，实测启用会让质量降 55–76%）→ 六轴并行评分（心理/信息/社会/逻辑/语言/认知）→ 47 子方向定位 → 多资源交叉确认 → 空间投票排名（加性 IDW，非连乘）→ 二次发散（5 条独立路径）→ BLQ 打分（参照 CombSUM 加性融合，自研维度权重）→ 方向词选择 → 注入上下文。21 节点全部纯算法，零 LLM。

**实验**：27 版本迭代，发散评分 v9→v26 从 2.01 到 4.05（+101%，满分 5，人工逐词判定）；召回命中率 ~90%；综合平均 ~3.5 分。万金油率从 74% 降到 4%。

**真实输出**（200 例批跑原始记录）：

| 用户输入 | 系统发散方向 | 跨到的学科 |
| --- | --- | --- |
| "快撑不下去了，活着怎么这么难？" | 当下觉察 / 内感受觉知 / **实在的本质是什么** | 心理学 → **存在主义哲学** |
| "准备独角兽公司面试，怎么准备有深度的问题？" | 根本原因分析 / **最近发展区** | 管理学 → **教育心理学** |
| "有限预算下私域流量运营挽回流失用户" | **默认模式网络激活** / **BDNF 脑源性神经营养因子** | 营销 → **认知神经科学** |
| "数据库查询特别慢怎么优化" | 不可变性与状态更新 / **SRP** | 运维 → **软件工程方法论** |
| "剑客在雪山遇到敌人的故事" | **契诃夫之枪** / 荣格原型 | 故事 → **叙事学 + 分析心理学** |
| 用户原创诗"我死在光来临前" | **可能世界与平行宇宙** | 诗歌 → **物理学多世界诠释** |

词库准入标准：**主模型裸读也能推出的词即废词**——P1 的价值在于给模型它自己想不到的方向。

</details>

<details>
<summary><strong>👑 提示词引擎 + 世界书动态注入</strong></summary>

**TweakPrompt 三轮**统一接管所有模块输出：Round 1 收集 → Round 2 重建 5 段消息结构（beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat）+ 宏替换 → Round 3 快照。

**世界书 3 种激活模式**：常驻（每轮注入）/ 正则（关键词触发）/ 动态（读取记忆表格数值条件触发——好感度 > 80 解锁特殊对话、任务进度到第三章切换世界观描述）。

**宏系统**：`{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + 自定义宏。

</details>

<details>
<summary><strong>🏗️ 系统架构</strong></summary>

三层：**功能层**（记忆/压缩/召回/预设/世界书/联网/文件操作……全局一份）→ **传导层**（每个窗口各自拉线，用 id 隔离，天然异步互不打断）→ **界面层**（网页/Bot/桌宠/VSCode 扩展，换界面不换能力）。

数据隔离：用户级（AI 源/全局设置）/ 角色卡级（记忆/对话/世界书/正则）/ 对话级（聊天记录/模式/子模式）。

22 个插件按统一规范生长，MCP 接外部工具，用户级插件宿主挂 Python/Node 程序——扩展不改本体代码。

</details>

<details>
<summary><strong>🔭 关于大窗口时代</strong></summary>

即使窗口扩到 10M+ tokens，我们依然保留分层记忆：①上下文利用率随长度衰减有充分实验证据；②~10K tokens 精选记忆承载 100K+ 历史信息量，成本差一个数量级；③结构化表格比散落对话更易被 AI 准确读写。

</details>

---

## 路线图

**已完成**：三层记忆 · 压缩系统 · P1 检索 · 提示词引擎 · 预设自动切换 · 记忆表格 · 世界书动态注入 · Live2D 桌宠 · 游戏陪伴 · 语音输入 · AI 做 PPT · MCP · 多窗口并行 · VSCode 扩展桥 · Discord Bot · 22 插件 · 回收站与备份回档 · 全栈诊断 · 多语言

**近期计划**：自驱动 P1（纯算法，零 LLM，句子级注意力）· 更多 Bot 平台 · 插件生态 · TTS / 文生图 · AI 游戏引擎（era 系血统，数值确定性代码+LLM 叙事+符号渲染）· 直播模式

---

## 技术栈

运行时 fount（Deno）· 后端 Node.js 兼容层 + Express 路由 · 前端原生 JS（ESM）· 智能检索 BM25+正则（纯 JS 零依赖）· 桌宠 Electron · 语音本地转录模型 · 跨平台 discord.js v14 · 存储纯 JSON

---

## 社区

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-立即加入-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

[📦 开箱即用的记忆预设](beilu-presets_2026-02-23.json) — 导入即用

分享角色卡 · 发布预设 · 贡献世界书 · 反馈 Bug · 提出建议 · 贡献代码 — 欢迎参与！

---

## 使用的技术与资源

- **语音转录**：[MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize)（本地部署，带说话人区分，模型约 1.8GB 首次使用时自动下载）
- **词向量**：[ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)（Speer & Lowry-Duda, 2017）
- **联想数据**：[SWOW（Small World of Words）](https://smallworldofwords.org/)中文联想数据集
- **分词与词典**：THUOCL / CoreNatureDictionary / Chinese-Synonyms 等公开资源
- **搜索引擎桥**：[ddgs](https://pypi.org/project/ddgs/)（Python TLS 指纹层，解决裸 fetch 被搜索引擎降级的问题）

## 致谢

- **[fount](https://github.com/steve02081504/fount)** — 项目初期的基础框架，提供了 AI 消息收发、服务源管理、模块加载等核心基础设施的初始参考。虽然项目现在已经在架构上完全独立演化，但 fount 在早期为我们节省了大量底层开发时间，提供了很多宝贵的想法参考，对此非常感谢
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — AI 角色扮演领域的先驱项目，其预设格式、角色卡规范和世界书系统已成为社区标准，本项目完全兼容其生态
- **SillyTavern 插件社区** — 感谢所有开源插件作者在渲染引擎、功能扩展等方面的探索和分享

---

<details>
<summary><strong>📸 更多功能截图（点开看）</strong></summary>

| | | |
|---|---|---|
| ![PPT详细](imgs/screenshots/ppt-detail.png) **PPT 全流程** | ![安全设置](imgs/screenshots/security-settings.png) **安全与任务流程** | ![安全中心](imgs/screenshots/security-center.png) **安全防护中心** |
| ![多语言](imgs/screenshots/i18n-support.png) **多语言支持** | ![CSS主题](imgs/screenshots/css-themes.png) **多套主题** | ![wiki](imgs/screenshots/wiki-guide.png) **内置 Wiki** |
| ![子模式](imgs/screenshots/sub-mode-agent.png) **子模式工作流** | ![菜单](imgs/screenshots/hamburger-menu.png) **上下文速览** | ![loop](imgs/screenshots/auto-loop.png) **自动/定时 Loop** |
| ![工具检测](imgs/screenshots/tool-detection.png) **环境检测** | ![记忆层](imgs/screenshots/memory-data-layers.png) **记忆文件结构** | ![扩展](imgs/screenshots/browser-automation.png) **浏览器自动化** |
| ![外部接口](imgs/screenshots/external-interface.png) **外部接口** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>

---

## 许可证

本项目基于 [fount](https://github.com/steve02081504/fount) 框架开发，已与原作者直接沟通获得授权使用。
