# API 配置详解

每个 AI 服务源在[AI服务源](beilu:settings/api)面板中的配置字段说明。

## 面板操作

[AI 服务源](beilu:settings/api)面板提供以下操作：

| 控件 | 说明 |
|------|------|
| 服务源列表 | 左侧显示已添加的 API 源，点击切换编辑 |
| 新建按钮 | 创建新的 API 服务源 |
| 删除按钮 | 删除当前选中的服务源 |
| 配置名称 | 文本输入，服务源的显示名称 |
| API 类型下拉 | 选择服务类型（Anthropic Claude / DeepSeek / Qwen / Google Gemini（原生）/ Ollama（本地原生）等）。选项由后端渠道元数据单源下发，选中后自动填默认端点、显示该服务的坑提示。概念上它把「生成器 + 渠道」两层拍平成一层，详见[服务源概览](overview.md)的「生成器与渠道」 |
| 坑提示区 | API 类型下拉下方，显示所选服务的已核实注意事项（如 Claude 的 temperature/top_p 互斥） |
| URL | 文本输入，API 端点地址；旁边有「恢复默认」按钮可随时回填该类型的默认端点 |
| Key | 文本输入，API 密钥（加密存储） |
| 模型 | 文本输入，模型名称标识符 |
| 获取模型列表 | 按钮，从 API 拉取可用模型列表供选择 |
| Extended Thinking | 开关，启用扩展思考能力（部分模型支持） |
| Budget 滑块 | 思考预算控制（Extended Thinking 开启后可用） |
| 保存按钮 | 保存当前配置 |
| 思维链折叠设置 | 配置思维链内容的显示标签和折叠行为 |

## 服务源配置模板

每个 AI 服务源的配置包含以下字段：

| 字段 | 说明 | 必填 | 示例 |
|------|------|------|------|
| name | 服务源名称（显示用） | 是 | `my-claude` |
| url | API 端点地址 | 是 | `https://api.anthropic.com/v1/chat/completions` |
| model | 使用的模型名称 | 是 | `claude-sonnet-4-20250514` |
| apikey | API 密钥 | 是 | `sk-ant-...` |
| provider | 渠道标识 | 推荐 | `claude` |
| use_stream | 是否使用流式响应 | 否 | `true`（默认） |
| custom_headers | 自定义请求头 | 否 | `{"X-Custom": "value"}` |

## 字段详解

### url（API 端点）

API 端点地址。不同服务商和生成器使用不同的端点格式。

默认端点会根据选择的渠道自动填充。如果使用中转服务或反向代理，替换为对应地址即可。注意不同生成器对应不同协议：

- **proxy 生成器**：OpenAI Chat Completions 格式（`/v1/chat/completions`）
- **claude-api 生成器**：Anthropic Messages 格式（`/v1/messages`）
- **gemini 生成器**：Gemini 原生格式
- **ollama 生成器**：Ollama 格式（`/api/chat`）

### model（模型名称）

要调用的模型标识符。不同服务商的模型名称不同：

| 服务商 | 模型名称示例 |
|--------|-------------|
| OpenAI | `gpt-4o`, `o3-mini` |
| Claude | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` |
| Gemini | `gemini-2.0-flash`, `gemini-2.5-pro` |
| DeepSeek | `deepseek-chat`, `deepseek-reasoner` |
| Qwen | `qwen-plus`, `qwen-max` |

模型名称可以在子模式或运行时被 `model_override` 覆盖。

### apikey（API 密钥）

服务商颁发的认证密钥。密钥在配置中加密存储，不会明文暴露在日志中。

### provider（渠道）

告诉 always-accompany 这是哪家服务商的 API，决定 OpenAI 兼容格式下的消息适配细节。**渠道只属于 proxy 生成器**——Ollama、Gemini 原生等走各自独立生成器的源没有这个字段。渠道共 10 个值（claude / openrouter-claude / openrouter / gemini / deepseek-r1 / deepseek / qwen / openai-reasoning / openai / generic），详见 [支持的 AI 服务商](providers.md)。

强烈建议手动选择渠道而非依赖自动检测。自动检测（留空或选"自动检测"）会根据 URL 和模型名猜测，可能误判导致 API 调用失败。

### use_stream（流式响应）

是否使用 SSE 流式响应。默认开启。

- **开启**：AI 的回复逐字出现，体验更好
- **关闭**：等待完整回复后一次性显示

某些场景必须开启流式：
- Qwen 的 enable_thinking 功能
- 部分本地引擎的推理模式

### custom_headers（自定义请求头）

JSON 对象，额外的 HTTP 请求头。通常用于：

- OpenRouter 的 `HTTP-Referer` 和 `X-Title`
- 企业内网的认证头
- 反向代理的自定义鉴权

### roleReminding（角色提醒）

布尔值，是否在发送给 AI 的消息中启用角色提醒（role reminding）。启用后，系统会在合适的位置插入角色提醒文本，帮助 AI 保持角色一致性。默认开启。

### ignoreFiles（忽略附件）

布尔值，是否忽略对话中附带的文件内容。某些模型不支持文件/图片输入时，开启此项可以避免 API 错误。

## 多服务源管理

### 角色级绑定

每个角色可以绑定独立的 AI 服务源。在角色设置中指定服务源后，与该角色的对话将使用指定的服务源，不受全局设置影响。

### 子模式覆盖

Code 和 Work 模式的每个子模式可以独立覆盖模型名称和采样参数。这使得同一服务源在不同工作阶段可以使用不同模型（例如简单任务用小模型，复杂分析用大模型）。

## 安全注意事项

- API 密钥通过 HTTPS 传输，在服务端加密存储
- 本地部署（Ollama / LM Studio）不需要 API 密钥
- 多用户场景下，每个用户的服务源配置独立隔离

## 导航

- [服务源概览](overview.md) — 基础概念
- [支持的 AI 服务商](providers.md) — 各服务商详情
- [模型参数](model-params.md) — 采样参数说明
