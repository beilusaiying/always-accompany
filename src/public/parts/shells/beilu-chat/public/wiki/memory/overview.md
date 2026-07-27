# 记忆系统

AI 自动记住对话中的重要内容——角色性格、用户偏好、发生过的事件，跨对话不丢失。

## 你需要做什么

**通常不需要管。** 记忆系统开箱即用：AI 自己写入、自己召回、自己归档。

想手动管理时：进入[记忆管理](beilu:mode/memory)，可以查看、编辑、删除任何记忆条目。

**一条重要的预期管理**：记忆系统幕后有 P1-P8 共 8 个专用 AI 预设，但**默认真正自动运行的只有 P1（检索）和 P2（超阈值总结归档）两个**。日总结、月总结、格式修复这些属于 P3-P6，默认关闭——想体验它们，要去[记忆管理](beilu:mode/memory)的 P 系列引擎面板手动开启并点"运行"。所以如果你发现"日总结从来没生成过"，不是坏了，是还没开。

## 自动运行流程

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>用户发消息</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>从 hot 层取常驻记忆</b><small>表格、永久记忆等每轮自动注入</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>P1 检索 AI 判断本轮要"想起"什么</b><small>需要时主动去温/冷层翻记忆文件</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>拼入上下文发给 AI</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>AI 回复含 &lt;tableEdit&gt;</b><small>写回记忆表格</small></div>
</div>

其中"想起记忆"这一步由 **P1 检索 AI** 完成：每条消息都会触发一次真实的 AI 子调用，由它像人一样主观判断"这句话需不需要翻旧记忆、翻哪些、怎么整理给主 AI"，而不是机械的关键词匹配。详见[记忆归档与检索](archival.md)。

AI 每次用到记忆后，消息下方会出现一条可折叠的「🧠 本轮运用记忆 (N)」溯源卡，展开能看到这轮用了哪些记忆文件——AI"为什么这样回答"是可以追溯的。

## 记忆的隔离范围：跟着角色卡走

记忆的隔离只有两层：

- **用户级**：你的记忆不会串到别的用户。
- **角色卡级**：每张角色卡有自己独立的一套记忆。

**对话（聊天窗口）不是隔离维度。** 同一张角色卡下开多少个对话窗口，用的都是同一份记忆、同一套表格、同一份任务清单——这个窗口记住的事，换个窗口 AI 照样记得。不要以为"新开一个对话 AI 就失忆了"，实际相反：AI 记得，只是新对话里没有旧对话的聊天记录而已。

## 三层记忆架构

记忆按"温度"分层，越热的层离 AI 越近：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot 热层</span>
活跃记忆，每轮对话自动注入上下文 <span class="wiki-badge">自动</span>
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm 温层</span>
近期记忆，P1 判断需要时检索取回 <span class="wiki-badge wiki-badge-blue">按需检索</span>
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">cold 冷层</span>
归档记忆，长期存储，搜索可达 <span class="wiki-badge wiki-badge-green">主动搜索</span>
</div>
</div>

## 记忆表格

记忆以**结构化表格**存储，chat 模式下有 #0 到 #9 共 10 张表，分别对应不同类型的信息（时空、角色特征、关于用户等）。AI 通过 `<tableEdit>` 标签对表格进行增删改查。

详见 [记忆表格(#0-#9)](tables.md)。也可在[记忆管理](beilu:mode/memory)中查看和管理。

## 记忆的生命周期

<div class="wiki-flow">
<div class="wiki-box wiki-box-green"><b>新信息产生</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>AI 写入 hot 层表格</b><small>&lt;tableEdit&gt; 标签</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>hot 层记忆每轮自动注入上下文</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">临时记忆攒满 / 点"结束当天"</div>
<div class="wiki-box wiki-box-blue"><b>归档到 warm 层</b><small>P2 顺带生成总结</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">满约一个月</div>
<div class="wiki-box wiki-box-purple"><b>整月搬迁到 cold 层归档</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>P1 检索 AI 从 warm/cold 层找回</b><small>需要时</small></div>
</div>

## 记忆管理界面

在[记忆管理](beilu:mode/memory)中，顶部工具栏提供 6 个快捷按钮：

| 按钮 | 名称 | 功能 |
|------|------|------|
| table | 表格 | 打开[数据表格编辑器](tables.md)，直接编辑 #0-#9 表格内容 |
| diag | P1诊断 | 查看 P1 检索的运行状态与缓存，以及最近的 P 系列运行记录（每条可展开看具体操作和 AI 原始回复） |
| snapshot | 快照 | 管理[记忆快照与 Git 快照](archival.md)，可创建/恢复 |
| retrieval | 检索配置 | 调整 P1 自动触发、引用条数、搜索轮数、超时等参数 |
| format | 格式检查 | 扫描记忆文件，统计格式符合/警告/错误，支持一键升级 |
| pseries | P系列引擎 | 编辑 [P1-P8 各预设](presets.md)的提示词、AI 源、模型等参数，手动运行 P2-P8 |

### 就地设置条（T040a）

管理面板常驻一条设置 chip 条，快速调整常用参数：

- P1 自动触发 toggle — 开关 P1 每轮自动召回
- 引用条数 number — 控制召回注入的条目数量
- 搜索轮数 number — P1 多轮搜索的最大轮次
- "更多设置"按钮 — 展开完整检索配置面板

### 三层主区

- **记忆内容**（content）— 子 Tab：文件树 / 表格。浏览和编辑记忆文件与表格数据
- **检索/诊断**（diagretr）— 子 Tab：诊断 / 检索。查看 P1 运行状态与调整检索参数
- **记忆运维**（ops）— 子 Tab：快照 / 格式 / 导入导出。备份恢复与格式维护

### 记忆文件浏览器

文件树展示 hot / warm / cold / code / work 五层目录结构：

- 以 `_` 开头和 `.bak` 文件默认隐藏，各层有专用图标映射
- 每个文件显示大小和相对时间
- 点击文件在右栏打开 JSON 编辑器，可直接修改并保存

**归档工具栏**提供批量操作：归档临时记忆 / 结束当天 / Hot 转 Warm / Warm 转 Cold / 归档已完成任务。

**code 层专用工具**：正则搜索、新建文件夹、导入/导出 zip。

## 常见疑问

**为什么日总结/月总结从来没出现过？** 它们归 P3/P5 管，默认关闭。去 P 系列引擎面板开启后手动运行才有。

**我在 code/work 模式写的热层 md，AI 怎么不记得？** 从 2026-07 起，code/work 模式的热层 md 文件只提供给 P1 检索 AI 阅读，不再直接塞进主 AI 的上下文。详见[热层记忆](hot-layer.md)。

**换了个对话窗口，AI 还记得之前的事吗？** 记得。同一张角色卡的所有对话共享同一份记忆（见上文"隔离范围"）。

## 深入了解

### 记忆 AI 预设

记忆系统的 8 个专用 AI 预设分工如下。注意**默认只有 P1、P2 自动运行**：

| 预设 | 职责 | 默认状态 |
|------|------|----------|
| **P1** 检索 AI | 每条消息触发一次，由 AI 主观判断要不要调记忆、调哪些、怎么整理注入 | 自动运行 |
| **P2** 总结/归档 AI | 临时记忆表攒满（超阈值）时自动生成总结并归档到温层 | 自动运行 |
| **P3** 每日总结 | 日终汇总当天事件（当前"结束当天"按钮执行的是机械归档，不调 AI） | 默认关闭 |
| **P4** 热→温转移 | 将过期/低权重记忆移入温层（当前自动搬迁为机械阈值操作，不调 AI） | 默认关闭 |
| **P5** 月度总结/归档 | 为温层月份编纂月总结（当前自动搬迁只做目录搬移，月总结留空） | 默认关闭 |
| **P6** 格式检查/修复 | 维护表格与记忆文件的格式 | 默认关闭 |
| **P7** 压缩 AI | 上下文过长时生成摘要；关闭时系统降级为机械裁剪 | 默认关闭 |
| **P8** 联网搜索 | P1 判断需要联网时启动，P8 再自己决定搜什么、搜几轮 | 默认关闭 |

也就是说，P3-P6 号称的"自动生命周期维护"目前由不调 AI 的机械归档承担（阈值搬移、文本拼接）；开启对应预设并手动运行，才是"AI 版"的体验。详见 [记忆AI预设(P1-P8)](presets.md)。

### 自驱动算法管线（储备能力）

除了现役的 AI P1，系统还内置了一套不依赖大模型的本地联想算法管线（P1 自驱动发散召回）。它是持续打磨中的核心储备组件，**当前默认休眠**（各模式声明 `selfDriven: false`），不参与日常对话。对其设计理念感兴趣可阅读 [P1 自驱动召回合集](../p1-recall/preface.md)。

### 与世界书的关系

记忆系统管理的是**动态产生的信息**（对话中发生的事、AI 学到的东西）。世界书管理的是**预设的背景知识**（世界观设定、角色资料、规则）。两者都通过注入系统（INJ）送入上下文，但来源和管理方式不同。

## 导航

- [记忆表格(#0-#9)](tables.md) — 表格结构与各表职能
- [热层记忆](hot-layer.md) — hot 层文件与自动注入机制
- [记忆AI预设(P1-P8)](presets.md) — 各预设的分工与运行链
- [上下文压缩](compression.md) — 压缩颗粒度与层级、AI 自主清理、消息屏蔽与可回溯
- [记忆归档与检索](archival.md) — warm/cold 层搬迁与 P1 检索
- [世界书概览](worldbook-overview.md) — 预设背景知识系统（[世界书编辑](beilu:editor/worldbook-edit)）
- [注入系统概览](inj-overview.md) — 信息如何进入上下文
