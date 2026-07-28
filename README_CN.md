<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-加入社区-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-点个_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | 中文 | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a></p>

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">在线 Wiki 使用指南</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">P1 技术论文</a></p>

> 本项目由一名刚毕业的大学生独立完成全部设计、架构与开发，借助 AI 辅助编程，融合算法设计、仿生学原理、框架架构和逻辑思维等多方面能力。

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# 或 chmod +x run.sh && ./run.sh   # Linux/macOS
```

浏览器打开 `http://localhost:1314` → 设置 AI 服务源 → 导入角色卡 → 开聊。Deno 运行时会在首次启动时自动下载，无需手动安装。至少需要一个 AI API Key。应用内置完整 wiki 教程，也可以直接看[在线 Wiki](https://beilusaiying.github.io/always-accompany/)。

> **提示：** 首次启动会比较慢——运行时需要下载依赖并初始化数据库，请等待页面完全加载后再操作。之后的启动会快很多。

---

## 为什么会有这个项目

或许你看过《底特律：变人》，或许看过《可塑性记忆》。里面的人形 AI 很智能，工作和陪伴融为一体。所以——我打算给自己也做一个。

**第一个要解决的问题是记忆。**

现在的 AI 上下文动辄百万 token，记忆存储工具和压缩工具也很多。但要么太平面，要么越到后期堆的东西越多。你不想让你的 AI 伴侣忘记你们之间的记忆，但按现有方案，这几乎不可能。

那么，记忆到底是什么？人的记忆其实很短暂——两天前的细节基本就模糊了。但给一个关键词，马上就能想起对应的、或者相关的记忆。这引出两个方向：**记忆怎么存，记忆怎么找。**

人不会记住每个细节，会选择性遗忘；但现在的 AI 不会——要么暴力压缩，要么塞进向量库。这违背了记忆的本性：你不可能马上忘记最近发生的事，也不可能每天把这几年做过的事都想一遍。

于是我们照着这个思路，做了下面这套东西。

---

## 记忆系统 — 像人一样存，像人一样忘

> 📖 详细图文教程：[在线 Wiki · 记忆系统](https://beilusaiying.github.io/always-accompany/#zh-CN/memory/overview.md)

**data 表格**存当天的记忆和永久的记忆——就像你可能永远记得初恋的名字、记得第一件事、记得告白那天。

往上是按时间距离分的三层，模拟人的选择性遗忘（记忆形成的分层机制 + 艾宾浩斯遗忘曲线）：

```
📋 data 表格 — 当天记忆 + 永久记忆（chat / code / work 各自独立）
🔥 热层（按周）— 每天的 data 自动归档，AI 按时间、事件、流程归档
🌤️ 温层（按月）— 二次压缩、提取关键词，像一本目录
❄️ 冷层（按年）— 深度归档，检索命中时依然可达
```

**注入权重按层级递减**：上下文 > data（永久记忆、轮回条目）> 热层 > 温层 > 冷层，同时做 top-k——按最近召回情况在每个层级内二次排序，层级之间还有缓冲层。一个完整的模拟记忆召回层 + 一个动态层。

按 AI 录入 data 的实际情况和每天的归档优化推导，运行一年后每轮注入依然小于 1 万 token（推导值：按一条 data 条目 ≈20 字符、每天 100 次互动、每日 AI 总结优化估算；热层实测每轮 ~7,000–11,000 tokens）。除了少数难点，这套东西**纯提示词 + 纯 JSON 文档驱动**——改归档策略、表格含义、检索风格，改提示词就行。存储成本≈0。

长上下文不是解药：实验证据（[Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)）表明上下文利用率随长度和位置衰减——都塞进去 ≠ 都看得到。~1 万 token 的精选记忆，承载的是 10 万+ token 历史的信息量。

热层还可以挂文档和相关记忆——比如角色扮演里的装备、其他角色参数。

---

## 记忆召回 — 不是检索，是发散 + 检索

> 📄 完整算法与实验：[P1 技术论文](docs/p1-paper/README.md) · 📖 [在线 Wiki · P1 专项](https://beilusaiying.github.io/always-accompany/#zh-CN/p1-recall/preface.md)

"给一个关键词马上想起相关记忆"——这不是简单的关键词检索。认知心理学的结论是：人的记忆是一张语义网络，一个概念被激活后沿关联边向邻居扩散、越远越弱（扩散激活理论，Collins & Loftus 1975）；"医生"出现后识别"护士"更快（启动效应，Meyer & Schvaneveldt 1971）。人的召回瞬时性极强，同时会控制深度和广度（工作记忆容量 4±1 组块，Cowan 2001）。

对照现有方案：简单检索做不到广度；让一个辅助 AI 来，它需要先发散再找，做不到瞬时性；而且记忆越多，开销越大。

**当前生产方案（AI P1）**：一个专职检索 AI 先找记忆，只把找到的交给回复 AI——各管各的，注意力不稀释。BM25 粗筛 + 正则精确匹配，检索可用免费轻量模型。

**正在优化的下一代（自驱动 P1）**：一条完整的纯算法管线，零 LLM、零网络：

```
用户对话 + 最近 5 轮上下文 + data
  → 分词（BCC 语料，排除"他的/这样"等常用词）
  → SWOW 联想发散 + NB300 六度发散模式 ×2（work 模式追加领域资源库）
  → 六轴定位（心理/信息/社会/逻辑/语言/认知）→ 47 子轴方向细化 → 温度画圆控制召回半径
  → 空间投票（IDW 加权多对一累加）→ BLQ 打分 → 召回 + 方向词注入
```

六轴给粗定位（词落在哪个学科方向），47 子轴刻画粗定位内部沿各细分方向的语义变化率——角色类似李导数（沿指定方向求变化率）；一条轴对一个词的定位产出是**多个信息点**而非一个分数（概念在语义空间里占的是区域不是点，Gärdenfors 概念空间理论 2000）。6 轴 → 47 子轴 → 资源库（SWOW / ConceptNet / Numberbatch 30 万词向量 / 情感与领域词库）构成多层互联结构：激活按层级传导、加性汇聚——类资源库 + 神经网络的结构。

BLQ 打分是加性融合（参照 CombSUM，Fox & Shaw 1994）：6 个证据维相加、4 个罚项相减——相加是 OR 门，证据互补；相乘是 AND 门，一个 0.3 就把全链拉崩。

**实测**：消费级配置（8GB 显存 + 32GB 内存）约 200ms 一次完整召回——每次对话都有一个庞大的瞬时记忆在背后支撑。27 个版本迭代，发散质量评分 +100% 以上，万金油率 74%→4%。实验数据全部公开在 [Wiki P1 专项](https://beilusaiying.github.io/always-accompany/#zh-CN/p1-recall/ch5-evolution.md)和[论文第六章](docs/p1-paper/zh/06_实验与评估.md)。

---

## 发散 — 给 AI 它自己想不到的方向

神经网络和注意力机制天生是**收拢**的：AI 看一大堆记忆再想现在的事，效果差、容易过拟合。所以我们做了**外部发散**：每次注入 100 token 以下的方向性内容——都是过拟合的 AI 自己想不出来的方向。少量方向词就能显著引导生成方向（方向性刺激提示 DSP，NeurIPS 2023）；外部机构负责发散、LLM 负责收敛，优于 LLM 自发散（外部脚手架研究 2025）。

**相关性发散**——你在坐车，突发奇想想拉开车门。电影里的场景是主角翻滚、受点擦伤；但你的安全教育告诉你这可能丧命。你开始想：为什么电影这么拍？——心理学、视觉表现、影视学。为什么会丧命？——物理学、生物学。这么短的时间，你跨了这么多学科。创造性联想恰好存在于"不太近、不太远"的最优语义距离带（远程联想理论 Mednick 1962；Orwig et al. 2025）。

**框架性发散**——两个完全不同的领域，功能和流程差不多，就可以建立联系：工厂流水线和 Agent，都是样本→稳定→模块化产出（结构映射理论，Gentner 1983）。

真实输出（200 例批跑原始记录）：

| 用户输入 | 系统发散方向 | 跨到的学科 |
| --- | --- | --- |
| "快撑不下去了，活着怎么这么难？" | 当下觉察 / **实在的本质是什么** | 心理学 → **存在主义哲学** |
| "准备独角兽公司面试，怎么准备有深度的问题？" | 根本原因分析 / **最近发展区** | 管理学 → **教育心理学** |
| "数据库查询特别慢怎么优化" | 不可变性与状态更新 / **SRP** | 运维 → **软件工程方法论** |
| "剑客在雪山遇到敌人的故事" | **契诃夫之枪** / 荣格原型 | 故事 → **叙事学 + 分析心理学** |
| 用户原创诗"我死在光来临前" | **可能世界与平行宇宙** | 诗歌 → **物理学多世界诠释** |

词库准入标准：**主模型裸读也能推出的词即废词**——发散要解决的就是两件事：过拟合，和 AI 的发散释放。

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

- **🧠 三层记忆**：热（每轮注入）/ 温（按需检索）/ 冷（深度归档），纯 JSON + 纯提示词驱动，零数据库 → [Wiki](https://beilusaiying.github.io/always-accompany/#zh-CN/memory/overview.md)
- **🎯 P1 前置检索**：专职小 AI 先找记忆再交给回复 AI，BM25 + 正则双引擎，检索可用免费模型
- **🗜️ 压缩系统**：三级层级 × 四类颗粒度 + AI 自主清理，全部可回溯 → [Wiki](https://beilusaiying.github.io/always-accompany/#zh-CN/memory/compression.md)
- **📊 10 张记忆表格**：结构化存储，AI 用 `<tableEdit>` 自动维护，信息隔离（角色不知道的事表格里就没有）
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
<summary><strong>🗜️ 压缩 — 颗粒度细到每一个文件</strong></summary>

说实话，我不知道为什么没有人做细化的压缩分类——尤其是代码场景，大都是暴力压缩和一键隐藏。

通过调查：AI 的上下文堆积主要来自反复读取的文件、thinking 和工具反馈。所以我们做了完整的压缩机制，颗粒度极其细致：

- **文件级别**——AI 读取的每一个文件，逐条 token 账单
- **工作级别**——thinking 和工具反馈每个轮回自动删除
- **上下文级别**——对话、分身注入、AI 读取分别管理，还可以只隐藏 AI 的话、保留用户的话

**你的信息 = 0 流失**：所有"清理"都只是不再发送，原文留在盘上随时恢复。加上提示词鼓励 MD 落盘，IDE 模式下 100MB 级的大项目里，AI 依然能看到你的第一句话——这直接减少 AI 的"任务属性替换"问题（做着做着忘了最初要干什么）。

AI 还有自主压缩能力：系统注入占用信号（50% 建议 / 70% 警告 / 85% 紧急），AI 用 `<contextClean>` 自己决定哪些文件不要了。

缓存效率实测（Opus + DeepSeek 渠道，含 AI 身份切换 + 自主压缩）：**70%–80%**。

→ [Wiki · 上下文压缩](https://beilusaiying.github.io/always-accompany/#zh-CN/memory/compression.md)

</details>

<details>
<summary><strong>🛡️ 安全与隐私</strong></summary>

考虑到公司级部署场景：CC 攻击、DDoS、Slowloris 的防护。

个人隐私侧：AI 可访问网站白名单（默认空白，安全默认拒外）、输出内容屏蔽（尤其跨平台协作功能）、AI 截图限制、L0–L5 六档权限闸、命令执行逐条审批。数据全部本地，音频不出机器。

</details>

<details>
<summary><strong>🏗️ 架构 — 核心功能插件化，扩展不改本体</strong></summary>

后端把核心功能做成插件，中间是一个信息站（传导层），前端只做展示 + 操作：

```
AIRP ─→ 输入/缓存/处理（隔离）─┐
Code ─→ 输入/缓存/处理（隔离）─┤→ 信息站（传导层）→ 前端展示
Work ─→ 输入/缓存/处理（隔离）─┘
```

所以扩展性很强：要加功能，直接做个扩展，支持 JS / Python 等。

**隔离级别**：
- **窗口级**——code、work、chat、airp、游戏陪伴、bot 各自隔离（游戏陪伴写入 chat 的 data）
- **角色卡级**——data、记忆、对话文件、正则按角色卡隔离
- **细粒度**——世界书、预设
- **用户级**——各种设置、角色卡
- **chatid**——同一模式开多窗口专用（code 多窗口 / bot），是为多窗口服务的独立隔离维度

三层：**功能层**（记忆/压缩/召回/预设/世界书/联网/文件操作，全局一份）→ **传导层**（每窗口各自拉线，id 隔离，天然异步）→ **界面层**（网页/Bot/桌宠/VSCode 扩展，换界面不换能力）。

</details>

<details>
<summary><strong>👑 提示词引擎 + 世界书动态注入</strong></summary>

**TweakPrompt 三轮**统一接管所有模块输出：Round 1 收集 → Round 2 重建 5 段消息结构（beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat）+ 宏替换 → Round 3 快照。

**世界书 3 种激活模式**：常驻（每轮注入）/ 正则（关键词触发）/ 动态（读取记忆表格数值条件触发——好感度 > 80 解锁特殊对话、任务进度到第三章切换世界观描述）。

**宏系统**：`{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + 自定义宏。

→ [Wiki · 世界书与注入](https://beilusaiying.github.io/always-accompany/#zh-CN/memory/worldbook-overview.md)

</details>

<details>
<summary><strong>🔭 关于大窗口时代</strong></summary>

即使窗口扩到 10M+ tokens，我们依然保留分层记忆：①上下文利用率随长度衰减有充分实验证据；②~10K tokens 精选记忆承载 100K+ 历史信息量，成本差一个数量级；③结构化表格比散落对话更易被 AI 准确读写。

</details>

---

## 我们现在可以做什么

用户录音转文字（记录时间线、人物）· AI 做 PPT · IDE（工具链可对比主流编程 Agent）· AIRP 全套（SillyTavern 生态对齐、渲染、MVU、世界书、动态上下文机制）· Live2D 桌宠、截图优化、游戏陪伴 · Discord Bot……

也就是说——**一个可以永远陪伴你的、和你一起工作的朋友，或者恋人。可以陪你去异世界冒险，可以帮你工作。**

再往后？自驱动系列做出来，就是快速传导的、永久记忆的 AI：投放到游戏行业是游戏陪伴；投到工作或医疗，就是长期记忆 + 随时可用的分析与状态记录 + 相同情况下的快速应对。最初的构想其实是真的人形智能——本机的小模型负责传感器模块，主智能体通过网络传导。这套记忆系统就是为那一天准备的。

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

分享角色卡 · 发布预设 · 贡献世界书 · 反馈 Bug · 提出建议 · 贡献代码 — 欢迎参与！

---

## 使用的技术与资源

- **语音转录**：[MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize)（本地部署，带说话人区分，模型约 1.8GB 首次使用时自动下载）
- **词向量**：[ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)（Speer & Lowry-Duda, 2017）
- **联想数据**：[SWOW（Small World of Words）](https://smallworldofwords.org/)中文联想数据集
- **分词与词典**：BCC 语料 / THUOCL / CoreNatureDictionary / Chinese-Synonyms 等公开资源
- **搜索引擎桥**：[ddgs](https://pypi.org/project/ddgs/)（Python TLS 指纹层，解决裸 fetch 被搜索引擎降级的问题）

理论参照（完整 56 条见[论文第一章](docs/p1-paper/zh/01_引言与相关工作.md)）：扩散激活（Collins & Loftus 1975）· 启动效应（Meyer & Schvaneveldt 1971）· 远程联想（Mednick 1962）· SWOW（De Deyne et al. 2019）· 概念空间（Gärdenfors 2000）· CombSUM（Fox & Shaw 1994）· BM25（Robertson et al. 1995）· IDW（Shepard 1968）· Hough 投票（Hough 1962）· RRF（Cormack et al. 2009）

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

## 链接

- 📖 在线 Wiki（使用指南 + P1 专项 + 实验数据）：https://beilusaiying.github.io/always-accompany/
- 📄 P1 技术论文（中英各 7 章）：[docs/p1-paper](docs/p1-paper/README.md)
- 💬 Discord 社区：https://discord.gg/agHeDq9bqU
