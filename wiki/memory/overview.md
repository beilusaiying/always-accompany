# 记忆系统

AI 自动记住对话中的重要内容——角色性格、用户偏好、发生过的事件，跨对话不丢失。

## 你需要做什么

**通常不需要管。** 记忆系统全自动运行：AI 自己写入、自己召回、自己归档。

想手动管理时：进入[记忆管理](beilu:mode/memory)，可以查看、编辑、删除任何记忆条目。

## 自动运行流程

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>用户发消息</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>从 hot 层取常驻记忆</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>召回引擎扫描 warm 层</b><small>匹配相关条目</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>拼入上下文发给 AI</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>AI 回复含 &lt;tableEdit&gt;</b><small>写回记忆表格</small></div>
</div>

## 三层记忆架构

记忆按"温度"分层，越热的层离 AI 越近：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot 热层</span>
活跃记忆，每轮对话自动注入上下文 <span class="wiki-badge">自动</span>
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm 温层</span>
近期记忆，按需召回（关键词匹配时拉入） <span class="wiki-badge wiki-badge-blue">召回引擎触发</span>
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
<div class="wiki-label">随时间推移</div>
<div class="wiki-box wiki-box-blue"><b>自动搬迁到 warm 层</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">继续老化</div>
<div class="wiki-box wiki-box-purple"><b>搬迁到 cold 层归档</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>召回引擎从 warm/cold 层检索拉回</b><small>需要时</small></div>
</div>

## 记忆管理界面

在[记忆管理](beilu:mode/memory)中，顶部工具栏提供 7 个快捷按钮：

| 按钮 | 名称 | 功能 |
|------|------|------|
| table | 表格 | 打开[数据表格编辑器](tables.md)，直接编辑 #0-#9 表格内容 |
| diag | P1诊断 | 查看 P1 召回引擎的运行状态与缓存 |
| snapshot | 快照 | 管理[记忆快照与 Git 快照](archival.md)，可创建/恢复 |
| retrieval | 检索配置 | 调整 P1 自动触发、引用条数、搜索轮数、超时等参数 |
| format | 格式检查 | 扫描记忆文件，统计格式符合/警告/错误，支持一键升级 |
| pseries | P系列引擎 | 编辑 [P1-P8 各预设](presets.md)的提示词、AI 源、模型等参数 |
| skills | 说明书库 | 管理不同模式下的说明书（触发规则、正文等） |

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

## 深入了解

### 记忆 AI 预设

记忆系统幕后有 8 个专用 AI 预设协同工作：

- **P1**：检索 AI——NLP 分词、联想扩展、四维打分，从温/冷层召回记忆
- **P2**：表格总结/归档——临时记忆超阈值时生成总结并归档到温层
- **P3**：每日总结——日终汇总当天事件
- **P4**：热→温转移——将过期/低权重记忆移入温层
- **P5**：月度总结/归档——为温层月份编纂月总结
- **P6**：格式检查/修复——维护表格与记忆文件的格式
- **P7**：压缩 AI——当上下文过长时生成摘要
- **P8**：联网搜索——需要外部信息时调用

详见 [记忆AI预设(P1-P8)](presets.md)。

### 与世界书的关系

记忆系统管理的是**动态产生的信息**（对话中发生的事、AI 学到的东西）。世界书管理的是**预设的背景知识**（世界观设定、角色资料、规则）。两者都通过注入系统（INJ）送入上下文，但来源和管理方式不同。

## 导航

- [记忆表格(#0-#9)](tables.md) — 表格结构与各表职能
- [热层记忆](hot-layer.md) — hot 层文件与自动注入机制
- [记忆AI预设(P1-P8)](presets.md) — 各预设的分工与运行链
- [上下文压缩](compression.md) — P7 压缩机制
- [记忆归档与检索](archival.md) — warm/cold 层搬迁与召回引擎
- [世界书概览](worldbook-overview.md) — 预设背景知识系统（[世界书编辑](beilu:editor/worldbook)）
- [注入系统概览](inj-overview.md) — 信息如何进入上下文
