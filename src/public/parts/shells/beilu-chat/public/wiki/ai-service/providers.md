# 支持的 AI 服务商

always-accompany 通过渠道（Provider）标识不同的 AI 服务商。在[AI服务源](beilu:settings/api)面板选择正确的渠道可以确保消息格式正确适配，避免 API 调用失败。

> **渠道是 proxy 生成器专属的概念**：本页列出的 10 个渠道都是"proxy 生成器 + OpenAI 兼容格式"下的服务商方言适配。Ollama（本地原生）和 Google Gemini（原生 API）走各自独立的生成器，**不在渠道列表里**——它们在面板的「API 类型」下拉中是与各渠道并列的独立选项。两层概念详见[服务源概览](overview.md)。
>
> 面板里选中某个类型后，下拉下方会直接显示该服务的坑提示，与本页各"注意事项"同源。

### Anthropic Claude

| 项目 | 说明 |
|------|------|
| 渠道标识 | `claude` |
| 默认端点 | `https://api.anthropic.com/v1/chat/completions` |
| 注意事项 | temperature 与 top_p 不能同时设置（同传返回 400）；max_tokens 必填 |
| 适用生成器 | proxy（OpenAI 兼容端点）/ claude-api（原生 Messages API） |

如果你使用 Claude 官方 API，有两种接入方式：
- **proxy 生成器 + claude 渠道**：走 OpenAI 兼容端点，配置简单
- **claude-api 生成器**：走 Anthropic 原生 `/v1/messages` 协议，支持更多 Claude 特性

使用中转或反向代理时，直接替换 URL 地址即可。

### OpenRouter -> Claude

| 项目 | 说明 |
|------|------|
| 渠道标识 | `openrouter-claude` |
| 默认端点 | `https://openrouter.ai/api/v1/chat/completions` |
| 注意事项 | Claude 系约束同上（temperature/top_p 互斥） |

通过 OpenRouter 平台调用 Claude 模型时使用此渠道。

### OpenRouter

| 项目 | 说明 |
|------|------|
| 渠道标识 | `openrouter` |
| 默认端点 | `https://openrouter.ai/api/v1/chat/completions` |
| 注意事项 | 无特殊限制 |

通过 OpenRouter 调用非 Claude 模型时使用。

### Google Gemini

| 项目 | 说明 |
|------|------|
| 渠道标识 | `gemini` |
| 默认端点 | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| 注意事项 | reasoning_effort 与 thinking_config 不能同传 |
| 适用生成器 | proxy（OpenAI 兼容端点）/ gemini（原生 API） |

### DeepSeek R1（推理系）

| 项目 | 说明 |
|------|------|
| 渠道标识 | `deepseek-r1` |
| 默认端点 | `https://api.deepseek.com/chat/completions` |
| 注意事项 | deepseek-reasoner 不支持 system 角色消息（自动合并进首条 user）；deepseek-reasoner 官方标注 2026-07-24 弃用，建议迁 V4 系 + 思考模式（选 `deepseek` 渠道） |

### DeepSeek

| 项目 | 说明 |
|------|------|
| 渠道标识 | `deepseek` |
| 默认端点 | `https://api.deepseek.com/chat/completions` |
| 注意事项 | 思考模式下 temperature/top_p/惩罚参数会被静默忽略 |

### Qwen（通义 DashScope）

| 项目 | 说明 |
|------|------|
| 渠道标识 | `qwen` |
| 默认端点 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| 注意事项 | 开启思考（enable_thinking）必须用流式；temperature 不能为 0；不同地区端点不同 |

### OpenAI 推理系（o1/o3/o4）

| 项目 | 说明 |
|------|------|
| 渠道标识 | `openai-reasoning` |
| 默认端点 | `https://api.openai.com/v1/chat/completions` |
| 注意事项 | 使用 `developer` 角色替代 `system` 角色 |

### OpenAI

| 项目 | 说明 |
|------|------|
| 渠道标识 | `openai` |
| 默认端点 | `https://api.openai.com/v1/chat/completions` |
| 注意事项 | 无特殊限制 |

### 通用 OpenAI 兼容（本地/自部署）

| 项目 | 说明 |
|------|------|
| 渠道标识 | `generic` |
| 默认端点 | `http://localhost:1234/v1/chat/completions` |
| 注意事项 | 适用于 LM Studio / vLLM / llama.cpp server / koboldcpp 等 |

## 渠道的作用

选择渠道后，always-accompany 会自动进行针对性的消息格式适配：

- **Claude 系**：头部 system 消息提取为顶层 system 字段（Anthropic 协议要求）
- **Gemini**：合并头部 system 为一条（兼容层转 systemInstruction）
- **DeepSeek R1**：system 消息合并进首条 user（R1 不接受 system 角色）
- **OpenAI 推理系**：system 角色替换为 developer 角色
- **通用**：合并多条 system 为一条（本地推理引擎兼容性）

## 自动检测

如果不选择渠道（或选择"自动检测"），always-accompany 会根据 API URL 和模型名称猜测服务商。但自动检测可能误判，建议手动选择。

## Ollama（本地模型）

Ollama 走独立的 ollama 生成器，不经 proxy。如果你在本地运行 Ollama，配置时选择 Ollama 类型的服务源即可。Ollama 支持的采样参数与 OpenAI 有所不同（例如使用 `repeat_penalty` 而非 `repetition_penalty`），always-accompany 会自动转换参数名称。

## 导航

- [服务源概览](overview.md) — 基础概念
- [API 配置详解](api-config.md) — 配置字段详解
- [模型参数](model-params.md) — 采样参数说明
