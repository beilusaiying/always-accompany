<p align="center">
  <img src="imgs/icon.jpg" alt="always-accompany" width="180">
</p>

<h1 align="center">always-accompany</h1>

<p align="center"><strong>一个专注于上下文与注意力机制的多元 AI + Agent 项目</strong></p>

<p align="center">陪伴、聊天、编程、工作共享同一套记忆与上下文框架——像科幻作品里那种 AI，陪你、也帮你干活。</p>

<p align="center"><strong>动态注意 · 固定注入 · 项目隔离 · 专项模式</strong></p>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-加入社区-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-点个_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> · 简体中文 · <a href="README_TW.md">繁體中文</a> · <a href="README_JA.md">日本語</a> · <a href="README_KO.md">한국어</a> · <a href="README_RU.md">Русский</a> · <a href="README_DE.md">Deutsch</a> · <a href="README_ES.md">Español</a> · <a href="README_FR.md">Français</a> · <a href="README_PT.md">Português</a></p>

> [!NOTE]
> **开发说明：**这个项目的主体由一人在约三个月内完成，随后用约一个月集中优化算法。由于开发周期短、功能范围大，当前工程结构、基础功能和边界处理仍可能存在不稳定或尚未完善之处。部分基础功能由 AI 辅助实现，复杂功能的框架、算法与关键设计由作者本人规划和指导，因此不同模块的成熟度并不完全一致。后续会持续进行人工复核、微调与工程化优化；如果遇到 Bug，欢迎提供复现步骤和日志。
>
> **后续计划：**停止增加新的插件和功能板块，把工作重心转向缩减核心内核、降低耦合，并将可拆分的功能逐步迁移到插件层。项目会补齐详细、稳定的插件协议，随后开展框架工程级的优化与渐进式重构，同时完善测试、文档和贡献流程，让更多开发者能够理解、扩展并参与这个项目。

---

## 它可以直接做什么？

- 进行长期聊天和角色扮演，可直接导入 SillyTavern 的角色卡、预设、世界书等社区格式；
- 像本地 Agent 工作台一样读取与修改项目文件、运行命令；
- 通过 Live2D / 图片桌宠、屏幕感知、游戏陪伴、语音输入，以及覆盖 9 个平台的 Bot 系统延伸到浏览器之外；
- 把长期材料保存在本地文件中，每一轮自动找出与当前问题相关的片段，并让不再需要的旧上下文退出；
- 编辑角色、提示词内容与顺序、注入身份与位置、条件触发规则、记忆召回路线、权限和插件，把它改造成自己的 AI。

**我们有什么？** 这些界面背后是同一套系统，真正的不同集中在四件事：

- **独特的记忆与上下文框架** — Data + hot / warm / cold 分层保存长期材料，一个收集上下文、检索记忆的工具（P1）在每轮回答前召回当前相关的片段；上下文清理做到文件读取级颗粒度、可逆，AI 也能自行放弃不再需要的已读文件（作者环境按计费口径实测缓存效率约 70–80%，非承诺值）；
- **全部内容可以编辑** — 角色、提示词、注入、记忆、召回路线、权限与插件都不是黑箱，想改哪一层都有入口；
- **一个高扩展的框架** — 核心功能以插件组织，经中间信息站传导，前端只做展示与操作；用户插件可用 JS、Python 或独立程序编写；
- **一个 agent 有的全部功能** — 文件、命令、浏览器、MCP、多窗口、审批与恢复齐备，并共享同一套记忆与上下文框架；它为完成大型项目而生，核心就是把有限的注意力用在刀刃上。

---

## 快速开始

只需要两样东西：

- 一个可用的 AI API；
- 会写简单的提示词。

有这两样就能马上上手体验。要提前说明的是：目前 AIRP 和 Chat 的提示词我们还在细做——现阶段以生产力为主，陪伴向的打磨会逐步补上。

如果你只想开始聊天，这就是全部成本。自驱动 P1 的本地检索服务（当前实测峰值内存约 2 GiB 量级）可以整体关闭；P1 参数、提示词注入位置、Code、Work 与插件都属于按需深入的配置，不是第一次使用的前置课程。

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# 或 chmod +x run.sh && ./run.sh   # Linux / macOS
```

启动器会在缺少 Deno 时自动下载运行时，并在依赖不完整时完成安装。页面就绪后浏览器通常会自动打开；也可以手动访问 `http://localhost:1314`。

| 1. 选择界面语言 | 2. 绑定 AI 服务源 |
|---|---|
| ![选择语言](imgs/screenshots/onboarding-language.png) | ![绑定 API](imgs/screenshots/onboarding-api.png) |

填入服务地址、API Key 和模型，保存后选择或导入一张角色卡，就能开始聊天。至少需要一个可用的 AI API；模型能力与费用取决于你绑定的服务。应用内置[完整 Wiki](site/wiki/getting-started/overview.md)，也可访问[在线版](https://beilusaiying.github.io/always-accompany/)。

> 首次启动通常更久：运行时需要下载依赖并初始化本地数据。请等页面完整出现后再操作；后续启动会更快。语音、桌宠等可选能力可能还有自己的首次下载或环境要求。

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
![IDE 编程](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Work 模式与 PPT**
![Work 模式 PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D 桌宠 + 屏幕感知**
![桌宠](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 六档权限模板 + 逐工具规则**
![权限设置](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ 分层压缩 × 逐条可控**
![压缩机制](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧭 四大主模式 + 辅助视图**：Smart 全智能、Chat 聊天 / 角色扮演、Code 编程、Work 工作各有独立记忆表与 P1 路线；另有 Bot 管理、游戏陪伴、记忆管理、ST 适配等辅助视图；
- **🧠 Data（可编辑的结构化记忆表）+ 三层记忆**：Data 与 `hot / warm / cold` 普通 JSON / MD 文件分别承接当前事实、近期材料与归档；内容可查看、可编辑；
- **🎯 P1（前置记忆召回）**：在主 AI 回答前，先从当前角色与模式允许读取的长期材料中寻找相关片段。Chat / Code / Work 当前默认使用本地算法路线；Smart / Bot 模式保留独立 AI 检索路线；两条路线互斥，也可以关闭；
- **🗜️ 上下文管理**：按消息、文件读取、工具结果和系统注入查看占用；普通清理只是把内容隐藏、不再发给 AI，记录仍留在磁盘、可恢复；
- **📊 分模式记忆表**：Chat 有 #0–#9 表，Code 与 Work 使用自己的表和私有目录，不把所有场景堆进同一张表；
- **👑 全部提示词可编辑**：内容、顺序、开关、system / user / assistant 身份、注入位置与条件都能调整；
- **💻 IDE 级工作流**：三栏布局、文件读取与编辑、命令执行、任务清单、多窗口与 VS Code 扩展桥；
- **🔌 MCP（外部工具连接协议）**：粘贴 JSON 接入外部工具；命令型服务需经过 owner 和环境变量白名单等安全门；
- **🐾 桌宠与游戏陪伴**：Live2D / 图片包、三种屏幕感知方式、主动评论、独立游戏陪伴循环和自适应频率；
- **🎙️ 本地语音输入**：MOSS-Transcribe-Diarize 本地转写，支持说话人分离与时间戳；目前只做语音转文字，不包含 AI 朗读；
- **🤖 9 个平台 Bot**：当前源码包含 Discord、Telegram、Slack、LINE、飞书、钉钉、微信、企业微信和 X 平台壳；各平台仍需按自身要求配置 Token、Webhook 或第三方桥接；
- **🔎 可选语义向量检索**：内置 beilu-vectordb（基于 Orama，支持全文 / 向量 / 混合搜索），默认关闭，需自配 embedding 端点后开启；与自驱动 P1 互补，而非二选一；
- **🧩 插件系统**：当前源码有 23 个内置插件目录，新用户模板默认列出 14 个；还可用 Python、Node 或独立程序编写用户插件；
- **🛡️ 本地数据与恢复**：应用数据保存在本机，支持隐藏恢复、回收与备份链；发送给远程 AI 或远程 embedding 服务的内容仍受你所选服务的数据政策约束；
- **🌐 多语言 · 🔬 白盒诊断 · 🎨 多套主题**：核心中 / 英 / 日 / 繁界面之外还提供其他社区翻译，部分低资源语言可能不完整。

---

## 我们到底打算解决什么？

记忆保存本身并不神秘。Data 是一份可写表格，`hot / warm / cold` 说白了就是你按“时间 + 事件”建三个文件夹、往里记 md；INJ（可编辑的提示词注入条目）和预设也延续了 SillyTavern 等角色前端长期探索的提示词编排方式。

但把它们组合起来，再加上 P1（一个收集上下文、检索记忆的工具），就成了一套天然的“向量 + 动态注入 + 记忆跟着当前任务走”的生态——一个高注意力、高信息密度的记忆库；再搭配我们做到文件级别的压缩，整条链路就完整了。

其实一开始，我们打算把 P1 做成一个小 AI 单独部署。但真正的问题出在保存之后：记忆越积越大，如果每轮都要专门启动第二个 AI 去翻，速度和花费还扛得住吗？小 AI 真能找得全吗？非得用付费 AI 不可吗？会不会记得越多、反应越慢？

落到日常，就是几个熟悉的场景：一个大项目，你让 AI 先看链路、框架、MD 再给它任务，结果做到一半 token 就快满了，一压缩就得重看一遍——多个 agent 一起跑时，上下文更是灾难；长任务里 AI 反复读同一个只改了几行的文件，上下文越堆越爆，你却删不掉；有时你本想开一个新项目，AI 却一头锚定到之前老项目的记忆上。

这些并非凭空假设：

- [Issue #6](https://github.com/beilusaiying/always-accompany/issues/6)
- [Codex #35226](https://github.com/openai/codex/issues/35226) · [Claude Code #34556](https://github.com/anthropics/claude-code/issues/34556)；
- [社区讨论](https://www.reddit.com/r/SillyTavernAI/comments/1q7p33c/how_longterm_memory_works_in_sillytavernai/)；
- 网页聊天产品的用户也在提项目记忆的透明度和跨项目串扰问题：[检索透明度请求](https://community.openai.com/t/feature-request-make-project-memory-transparent-searchable-and-user-controlled/1385159) · [项目专属记忆请求](https://community.openai.com/t/project-specific-memory-in-chatgpt/1140856)。


### 保存后，怎样输出给 AI

通过自研的 **P1 前置记忆召回**：它先围绕用户当前对话扩展检索线索，再从当前角色与模式允许读取的长期材料中找出相关原文，交给主 AI。可以把它理解为运行在模型外的动态注意机制——当前问题决定找什么，长期材料提供候选，只有本轮选中的片段会进入回答。

在使用上这意味着：你不必复述原句，一句相关但不完全相同的话也可能把旧事带回来；召回之后，界面会显示本轮实际使用了哪些记忆——你验证的是记录本身，而不是 AI 的一句“我记得”。

---

## 详细机制

<details>
<summary><strong>🧠 Data 与三层递归记忆 — 为什么仍然要分层</strong></summary>

`hot / warm / cold` 首先是可读写的生命周期目录，不是神秘数据库：

```text
🔥 hot  — 近期、高频、正在使用的材料
🌤️ warm — 阶段性整理与归档材料
❄️ cold — 更长期的历史材料
📊 Data — 当前模式下可编辑、可验证的结构化事实
```

分层让固定注入、按需召回和深层归档拥有不同成本与用途。原始材料留在普通 JSON / MD 中，用户可以直接检查和改正；P1 再决定这一轮从哪些层取回片段。

长上下文研究已经观察到位置偏差与任务变复杂后的利用下降：[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) · [RULER](https://arxiv.org/abs/2404.06654) · [Found in the Middle](https://aclanthology.org/2024.findings-acl.890/)。这些论文说明“能放进去”与“稳定用得到”不是同一件事，但不直接证明本项目方案更好。

</details>

<details>
<summary><strong>🗜️ 上下文管理 — 从整段压缩到文件读取级清理</strong></summary>

AI 执行真实任务会产生大量过程内容：反复读取的文件、旧工具结果、已经消费的指令标签和过时消息。always-accompany 同时提供自动压缩、按类型清理和逐条选择；默认清理使用 `_hidden` 标记，让记录留在磁盘，但不再发送给 AI。

AI 也可以输出 `<contextClean>` 请求清理；系统会保护用户原话，并可设置最低 token 阈值，避免在上下文仍很小时频繁破坏提示词缓存。永久或高风险操作不应与普通隐藏混用。

| 多层压缩与颗粒度 | 文件读取级清理 |
|---|---|
| ![多层压缩面板](imgs/screenshots/compression-multi.png) | ![文件读取级别的清理](imgs/screenshots/context-file-cleanup.png) |

普通用户只需选择不再需要的文件读取或消息；想深入控制时，再查看 token 账单、类型、时间和来源。

</details>

<details>
<summary><strong>🔬 自驱动 P1 — 模型外的动态记忆注意链</strong></summary>

当前生产链是 Node0–4，而不是旧文档中的 21 节点描述：

```text
Node0  当前输入 + 最近用户消息 + 当前模式 Data
  ↓
Node1  分词、词性、时间、专名与短语锚点
  ↓
Node2  SWOW / ConceptNet / 词林 / ATOMIC / 领域词等关联扩展
  ↓
Node3  BLQ(自研算法) / NB300 / WordNet 等多证据信号过滤
  ↓
Node4  回到 Data、hot / warm / cold 与模式记录，结合 BM25、时间、层级、Top、importance 等排序
  ↓
recalledRecords + directionWords + trace
```

联想词不是记忆事实；候选必须回到真实记录层才能成为最终召回结果。白盒面板会显示输入单元、各节点候选与删除原因、索引状态、最终来源和错误，便于判断“没召回”究竟是没有匹配、资源降级还是链路失败。

![自驱动 P1 白盒测试](imgs/screenshots/p1-self-driven-diagnostics.png)

白盒面板证明每个节点和真实来源都可以检查；召回质量仍需要在同一语料、同一任务和带标准答案的数据上评估。完整运行边界见 [P1 当前生产合同](site/wiki/p1-recall/ch7-current-runtime.md)。

</details>

<details>
<summary><strong>👑 全部提示词都能编辑 — 默认可用，也能继续改造成自己的 AI</strong></summary>

角色设定、系统规则、模式说明、记忆数据槽和工具教学等提示词条目都能在界面中编辑。每条内容都可以调整：

- 实际文字
- 先后顺序
- 是否启用
- 以 system、user 还是 assistant 身份发送；
- 插入聊天历史的哪个位置；
- 只在 Chat、Code、Work、Bot 或指定条件下生效。

</details>

<details>
<summary><strong>🔒 AI 能行动，但每种操作都有自己的边界</strong></summary>

文件写入会按工具、路径和三态规则得到 `deny / ask / allow`；命令还会经过黑名单、灰名单和远程白名单；server 部署下的敏感配置与子进程能力需要 owner 开启。

L0–L5 是一组从严控到全部放行的快捷模板，用户还可以继续细分到具体工具与路径。L5 会跳过审批，是明确的高风险选择；工作区围栏、部署模式和各插件自己的安全门仍应独立理解。

![AI 编辑权限细分](imgs/screenshots/ai-permission-rules.png)

</details>

<details>
<summary><strong>🏗️ 系统架构与隔离边界</strong></summary>

always-accompany 以 Deno 后端和原生 Web 前端运行，通过 Shell、Plugin、Service Generator 与 yonban 功能层组织能力。界面调用、模式路由、文件 / 工具执行、持久化和异步结果分别有明确入口。

| 边界 | 当前作用 |
|---|---|
| 用户 | 多用户 / server 场景下的持久化根边界 |
| 角色卡 | 不同角色、关系、客户或项目使用不同记忆根、设定与对话 |
| 模式 | Chat / Code / Work 使用不同表、私有目录、预设记录与 P1 路线；同一角色卡的通用长期材料仍可能共享 |
| 窗口 | 约束本轮输入、P1 候选与结果、工作区和异步回传 |

</details>

<details>
<summary><strong>🔭 关于 1M、2M 与更大的上下文窗口</strong></summary>

更大的窗口非常有价值，但容量、注意力、成本与任务状态不是同一件事。always-accompany 做分层与召回，主要是为了提高注意力、优化上下文里的存储方式，尤其面向现在的大型代码项目和长期聊天。

或许你遇到过：聊天越久、记忆越多，AI 接收的东西越多，反应和记忆反而开始混乱、变慢；写代码则是——哪怕给你 1M 上下文，大项目也能马上撞到上限。

</details>

---

## 路线图

**当前仓库已经具备的入口与实现**：Data + 三层记忆 · 上下文管理 · 自驱动 P1 / AI P1 · 全提示词编辑与预设切换 · 模式记忆表 · 条件知识动态注入 · Live2D / 图片桌宠 · 屏幕感知与游戏陪伴 · 本地语音输入 · PPT 生成 · MCP · 多窗口 · VS Code 扩展桥 · 9 个平台 Bot · 23 个内置插件目录 · 用户插件宿主 · 回收 / 备份链 · 白盒诊断 · 多语言与主题。

**近期方向**：更多 Bot 平台 · 插件生态与示例 · TTS / 文生图 · AI 游戏引擎（确定性数值状态 + LLM 叙事 + 符号渲染）

---

## 技术栈

Deno 运行时（Node.js 兼容） · Express 风格路由 · 原生 JavaScript / ESM 前端 · WebSocket · JSON / MD 本地存储 · Electron 桌宠 · Python 可选服务（P1 资源、STT、PPT）· discord.js v14 · VS Code 扩展桥。

架构说明见[系统架构](site/wiki/developer/architecture.md)，消息、工具与权限链见 [YonBan 工具体系](site/wiki/yonban/tools.md)和[审批机制](site/wiki/yonban/approval.md)。

---

## 社区

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-立即加入-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

分享角色卡 · 发布预设与条件知识 · 贡献插件 · 反馈 Bug · 提出真实使用案例 · 参与 benchmark · 贡献代码。

---

## 使用的技术与资源

- **语音转录**：[MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize)（本地部署，模型约 1.8 GB，首次使用时单独下载）
- **词向量**：[ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)（Speer & Lowry-Duda, 2017）
- **联想数据**：[SWOW（Small World of Words）](https://smallworldofwords.org/) 中文联想数据
- **分词与词典**：THUOCL、CoreNatureDictionary、Chinese-Synonyms 等公开资源
- **搜索引擎桥**：[ddgs](https://pypi.org/project/ddgs/)（用于搜索请求与结果获取）

## 致谢

- **[fount](https://github.com/steve02081504/fount)** — 项目早期的参考框架，提供了 AI 消息处理、服务源管理和模块加载等基础设施思路，节省了大量底层开发时间；
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — AI 角色扮演与提示词生态的重要先行者。always-accompany 支持导入其角色卡、预设和世界书等社区格式；
- **SillyTavern 插件社区与所有开源资源作者** — 感谢在渲染、角色、扩展、检索和工具链上的探索与分享。

## 为什么做这个项目

> 本项目的设计、架构与开发由一位想找工作的家里蹲完成(大雾)，借助 AI 辅助编程，将算法设计、仿生学思路、框架架构与逻辑思考结合在一起。

always-accompany 不是为了把热门功能塞进同一个菜单——一开始只是作者自己想用 :)。当然，它也确实有完整的插件与框架体系，并兼容多种语言。

---

<details>
<summary><strong>📸 更多功能截图（点开看）</strong></summary>

| | | |
|---|---|---|
| ![PPT 详细](imgs/screenshots/ppt-detail.png) **PPT 全流程** | ![安全设置](imgs/screenshots/security-settings.png) **安全与任务流程** | ![安全中心](imgs/screenshots/security-center.png) **安全防护中心** |
| ![多语言](imgs/screenshots/i18n-support.png) **多语言支持** | ![CSS 主题](imgs/screenshots/css-themes.png) **多套主题** | ![Wiki](imgs/screenshots/wiki-guide.png) **内置 Wiki** |
| ![子模式](imgs/screenshots/sub-mode-agent.png) **子模式工作流** | ![菜单](imgs/screenshots/hamburger-menu.png) **上下文速览** | ![Loop](imgs/screenshots/auto-loop.png) **自动 / 定时 Loop** |
| ![工具检测](imgs/screenshots/tool-detection.png) **环境检测** | ![记忆层](imgs/screenshots/memory-data-layers.png) **记忆文件结构** | ![扩展](imgs/screenshots/browser-automation.png) **浏览器自动化** |
| ![外部接口](imgs/screenshots/external-interface.png) **外部接口** | | |

</details>
