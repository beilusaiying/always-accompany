# 添加 AI 服务源

[设置 → AI服务源](beilu:settings/api)添加 API，让 always-accompany 连接 AI。

## 快速开始

1. 进入[AI服务源](beilu:settings/api)设置面板
2. 填写 API 地址（URL）
3. 填写 API 密钥（Key）
4. 选择模型名称
5. 选择渠道（Provider），告诉 always-accompany 这是哪家的 API
6. 保存配置

### 渠道怎么选

渠道决定 always-accompany 如何适配 API 的消息格式：

- 用 Claude 就选 `Anthropic Claude`
- 用 OpenRouter 转 Claude 就选 `OpenRouter -> Claude`
- 用本地模型就选 `通用 OpenAI 兼容`
- 不确定就选 `自动检测`（不推荐，可能误判）

详见 [API 配置详解](api-config.md)。

## 配置多个服务源

always-accompany 支持配置多个服务源，你可以：

- 为不同模式绑定不同服务源（聊天用 Claude，编程用 GPT）
- 为不同角色绑定不同服务源
- 为不同子模式绑定不同服务源

## 支持的服务商

| 服务商 | 说明 |
|--------|------|
| OpenAI | GPT 系列模型 |
| Anthropic Claude | Claude 系列模型（支持官方 API 和 OpenAI 兼容端点） |
| Google Gemini | Gemini 系列模型 |
| xAI Grok | Grok 系列模型（逆向 API） |
| Ollama | 本地部署的开源模型 |
| DeepSeek | DeepSeek 系列模型 |
| Qwen（通义） | 通义千问系列模型 |
| OpenRouter | 多模型聚合平台 |
| 通用 OpenAI 兼容 | LM Studio / vLLM / llama.cpp 等本地引擎 |

详见 [支持的 AI 服务商](providers.md)。

## 生成器类型

always-accompany 内部有多种 **生成器（Service Generator）**，每种对应一类 API 协议：

| 生成器 | 协议 | 适用场景 |
|--------|------|---------|
| proxy | OpenAI Chat Completions | 最通用，大多数服务商走此通道 |
| claude-api | Anthropic Messages API | Claude 官方原生 API |
| gemini | Gemini API | Gemini 官方 API |
| grok | Grok 逆向 API | xAI Grok |
| claude | Claude 逆向 API | Claude 逆向 |
| ollama | Ollama API | 本地 Ollama |

其中 **proxy** 是最常用的生成器，它支持所有 OpenAI 兼容格式的 API（包括 OpenRouter、DeepSeek、Qwen 等）。

## 服务源是什么

always-accompany 本身不包含 AI 模型，它通过 API 调用外部 AI 服务。服务源就是这个 API 连接的配置——包括 API 地址、密钥、要使用的模型等信息。

打个比方：如果 always-accompany 是电话机，服务源就是电话卡。没有电话卡，电话机再好也打不出去。

## 快速导航

- [支持的 AI 服务商](providers.md) — 各服务商详情与配置要点
- [API 配置详解](api-config.md) — 配置字段说明
- [模型参数](model-params.md) — temperature、top_p 等参数说明
