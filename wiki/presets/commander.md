# 司令员模式

司令员模式（Commander Mode）是预设引擎的高级运行模式。在此模式下，预设接管整个消息序列的组装——不再由各 provider 各自拼装，而是由预设引擎按 **五段拼装** 规则统一产出最终发给 AI 的消息列表。

普通模式下，预设只提供"指令片段"，由 provider 自行决定放在哪里。司令员模式下，预设就是"总指挥"，精确控制每一段内容的位置。

## 五段拼装

司令员模式将最终消息分为五个段落，按固定顺序排列：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber wiki-box-full"><b>1. beforeChat (头部预设)</b><small>beilu_preset_before — 系统指令、角色设定、世界书</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. injectionAbove (@D>=1 注入)</b><small>beilu_injection_above — 深度 >= 1 的注入条目</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>3. chatSegment (聊天历史)</b><small>provider 自建 — 对话核心消息序列</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>4. injectionBelow (@D=0 注入)</b><small>beilu_injection_below — 记忆、实时上下文等</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red wiki-box-full"><b>5. afterChat (尾部预设)</b><small>beilu_preset_after — jailbreak、格式要求等</small></div>
</div>

### 各段职责

| 段 | 字段名 | 内容 | 位置语义 |
|----|--------|------|---------|
| beforeChat | beilu_preset_before | 系统指令、角色设定、世界书等 | AI 最先看到的指令 |
| injectionAbove | beilu_injection_above | 深度 >= 1 的注入条目 | 聊天历史上方 |
| chatSegment | _(provider 自建)_ | 聊天历史消息序列 | 对话核心 |
| injectionBelow | beilu_injection_below | 深度 = 0 的注入条目（记忆、实时上下文等） | 聊天历史下方，贴近最新消息 |
| afterChat | beilu_preset_after | 尾部指令（jailbreak、格式要求等） | AI 最后看到的指令 |

## 共享层实现

五段拼装逻辑收敛在 `_shared/commanderAssembly.mjs` 中，所有 6 家 provider（proxy / grok / claude / claude-api / ollama / gemini）共用同一份拼装代码。

### 为什么参数化而非直接返回

六家 provider 在消息形状上有本质差异：

| Provider | 消息形状 |
|----------|---------|
| proxy | OpenAI 标准 messages（带元数据标记） |
| grok / claude | 简单 `{role, content}` |
| ollama | `{role, content}` + 图片字段 |
| gemini | Gemini parts 形状（role 映射 model） |
| claude-api | Anthropic 原生格式 + 顶层 system 字段 |

因此共享层采用参数化设计：

- `mapMsg`：各 provider 自行提供"段消息 -> 目标形状"的映射函数
- `chatSegment`：各 provider 预先构建好的聊天消息段
- `extractSystem`：Anthropic 系 provider 需要将 before/after 段提取为顶层 system 字段
- `cacheBoundary`：是否做缓存边界优化

### 缓存边界优化

当 injectionBelow 的首条消息超过 1000 字符时（通常是记忆数据），共享层会将其从底部移到聊天段的倒数第 1 条之前。这样做的目的是利用 API 的缓存机制——记忆数据相对稳定，贴近缓存边界可以提高缓存命中率。

## 门控与校验

### 司令员模式门控

预设条目中包含 `commander_mode` 标记时，provider 进入司令员分支。门控检测是双值 AND 逻辑——既要预设标记存在，又要有实际段内容。

### Schema 校验

共享层调用 `validateCommanderPreset()` 校验预设段字段的存在性和类型。四个段字段（beilu_preset_before / beilu_injection_above / beilu_injection_below / beilu_preset_after）应为数组类型。校验异常只告警不中断（fail-safe），不影响消息产出。

## TweakPrompt 中的司令员产出

预设引擎在 TweakPrompt Round 2 阶段产出司令员段内容：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>1. buildAllEntries()</b><small>引擎产出四段内容</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>2. 写入 extension</b><small>beforeChat / afterChat → beilu_preset_before / beilu_preset_after</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>3. 写入 extension</b><small>injectionAbove / injectionBelow → beilu_injection_above / beilu_injection_below</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>4. Provider StructCall 拼装</b><small>从 extension 读取 → assembleCommanderMessages()</small></div>
</div>

## 何时使用司令员模式

| 场景 | 是否需要 |
|------|---------|
| 简单对话 | 不需要，普通模式足够 |
| 角色扮演、需要精确控制提示词位置 | 推荐使用 |
| 自定义复杂提示词架构 | 必须使用 |
| 编程/工作模式 | 已由内置预设自动启用 |

## 导航

- [预设系统概览](overview.md) — 预设基础概念
- [预设条目结构](structure.md) — 条目字段详解
- [消息管线](../developer/message-pipeline.md) — 完整消息流转链路
