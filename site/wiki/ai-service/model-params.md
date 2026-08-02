# 模型参数

模型参数（也叫采样参数）控制 AI 生成文本的风格和行为。调整这些参数可以让 AI 的回复更有创意、更精确、更长或更短。可在[AI服务源](beilu:settings/api)面板的参数区域调整。

## 参数列表

### 核心参数

| 参数 | 范围 | 说明 |
|------|------|------|
| temperature | 0 - 2.0 | 生成温度。越高回复越随机多变，越低越确定保守。0 = 几乎总是选最可能的词 |
| max_tokens | 1 - 无上限 | 最大输出 token 数。限制 AI 回复的最大长度 |
| top_p | 0 - 1.0 | 核采样。只从累积概率前 top_p 的词中选择。1.0 = 不限制 |

### 采样控制参数

| 参数 | 范围 | 说明 |
|------|------|------|
| top_k | 0+ | Top-K 采样。只从概率最高的前 K 个词中选择。0 = 不限制 |
| top_a | 0+ | Top-A 采样。过滤掉概率低于最高概率 * top_a 的词。OpenRouter 专属 |
| min_p | 0+ | Min-P 采样。过滤掉概率低于最高概率 * min_p 的词 |

### 惩罚参数

| 参数 | 范围 | 说明 |
|------|------|------|
| frequency_penalty | -2.0 - 2.0 | 频率惩罚。正值降低已出现词的重复概率，负值鼓励重复 |
| presence_penalty | -2.0 - 2.0 | 存在惩罚。正值鼓励谈论新话题，负值鼓励围绕已有话题 |
| repetition_penalty | 0+ | 重复惩罚。1.0 = 无惩罚，大于 1 减少重复。Ollama / 本地模型专用 |

### 思考参数

| 参数 | 说明 |
|------|------|
| extended_thinking | 是否启用扩展思考（部分模型支持，如 Claude / Qwen 思考模式）。开关见[AI服务源](beilu:settings/api)面板 |
| thinking_budget | 思考预算（token 数，最小 1024）。extended_thinking 开启后可用 |

### 其他参数

| 参数 | 说明 |
|------|------|
| seed | 随机种子。设定固定值可以使结果可复现（-1 = 随机） |

## 参数优先级

always-accompany 中模型参数有多个来源，按以下优先级覆盖：

```
扩展层覆盖 (extension.beilu_model_params)
    ↑ 覆盖
子模式参数
    ↑ 覆盖
运行时参数面板 (runtimeParams)
    ↑ 覆盖
预设携带参数 (eng.modelParams)
    ↑ 覆盖
PARAM_SCHEMA 默认值
```

- **预设携带参数**：预设 JSON 中自带的参数值
- **运行时参数面板**：用户在参数面板中手动调整的值（持久化到 runtime_params.json）
- **子模式参数**：Code / Work 子模式独立覆盖的参数
- **扩展层覆盖**：由 beilu-memory 或其他插件在运行时动态注入的参数

### 运行时参数面板的覆盖键

运行时参数面板共提供 **15 个覆盖键**，每个键都有"用预设值"的默认哨兵（留在默认值 = 不覆盖，完全交给预设）：

| 分组 | 键 |
|------|-----|
| 上下文与流式 | context_msg_limit / stream / openai_max_context / openai_max_tokens |
| 消息后处理与预填充 | prompt_post_processing / prefill_enabled / claude_prefill_mode |
| 采样参数 | temperature / top_p / top_k / min_p / frequency_penalty / presence_penalty |
| 扩展思考 | extended_thinking / thinking_budget |

按用户隔离存储（per-user 视图），多窗口/多用户互不污染。

### 参数缺省单源

所有参数的默认值统一由 `PARAM_SCHEMA` 定义。引擎层提取默认值、应用层空窗兜底、前端 UI 的 min/max/step 三处共用同一张表，确保一致性。

## 各服务商的参数支持

不同服务商支持的参数子集不同。always-accompany 的参数应用层（applyModelParams）按服务商的 API 形状自动裁剪：

### OpenAI 形状（proxy / grok）

支持全部采样参数。top_a 仅在此形状可用（OpenRouter 专属功能）。

### Gemini 形状

支持：temperature / top_p / top_k / max_tokens / frequency_penalty / presence_penalty / seed

参数名自动转换（例如 `top_p` -> `topP`，`max_tokens` -> `maxOutputTokens`）。

### Ollama 形状

支持：temperature / top_p / top_k / repetition_penalty / max_tokens / min_p / seed

参数名自动转换（例如 `repetition_penalty` -> `repeat_penalty`，`max_tokens` -> `num_predict`）。

### Anthropic 形状（claude-api / claude）

默认不传采样参数。Anthropic 新版模型（Opus 4.7+）不支持 temperature / top_p / top_k（设非默认值会返回 400 错误）。max_tokens 为必填参数。

## model_override（模型切换）

`model_override` 不是采样参数，但通过同一通道传递。它用于在运行时切换 AI 模型，而不改变服务源配置：

- 子模式可以各自指定不同模型
- 分身对话可以切换到不同模型

解析优先级：`beilu_model_params.model_override` > 服务源 `config.model`

## 哨兵守卫

参数应用层有"哨兵守卫"机制：当参数值等于默认值（= 用户未改）时，不下发给 API，避免无谓覆盖服务商自身的默认行为。

例如：
- temperature = 用户设的任何值都下发（含 0）
- top_p = 1.0 时不下发（1.0 是多数 API 的默认值）
- top_k = 0 时不下发
- seed = -1 时不下发

## 调参建议

| 场景 | 推荐设置 |
|------|---------|
| 角色扮演 / 创意写作 | temperature 0.8 - 1.2，top_p 0.9 - 0.95 |
| 日常对话 | temperature 0.7 - 0.9 |
| 编程辅助 | temperature 0.2 - 0.5 |
| 数据分析 / 精确回答 | temperature 0 - 0.3 |
| 减少重复 | frequency_penalty 0.3 - 0.8 |

## 导航

- [API 配置详解](api-config.md) — 服务源配置
- [预设条目结构](../presets/structure.md) — 预设如何携带参数
