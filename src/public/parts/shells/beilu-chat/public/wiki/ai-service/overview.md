# 添加 AI 服务源

[设置 → AI服务源](beilu:settings/api)添加 API，让 always-accompany 连接 AI。

## 快速开始

1. 进入[AI服务源](beilu:settings/api)设置面板
2. 在「API 类型」下拉里选你用的服务（用 Claude 官方/中转就选 `Anthropic Claude`，用 DeepSeek 就选 `DeepSeek`，本地 Ollama 就选 `Ollama（本地原生）`……）
3. 填写 API 地址（URL）——选好类型后会自动填入该服务的默认端点，用中转/反代直接替换成中转地址即可
4. 填写 API 密钥（Key）
5. 填写或点「获取模型列表」选择模型名称
6. 保存配置

选好类型后，下拉下方会出现这家服务的**坑提示**（比如 Claude 的参数互斥、Qwen 的思考模式要求），照着提示避坑即可。

### 类型怎么选

- 用 Claude（官方或中转）就选 `Anthropic Claude`
- 用 OpenRouter 转 Claude 就选 `OpenRouter -> Claude`
- 用本地推理引擎（LM Studio / vLLM 等）就选 `通用 OpenAI 兼容（本地/自部署）`
- 本地 Ollama 就选 `Ollama（本地原生）`
- 实在不确定就选 `OpenAI 兼容（自动检测）`——不推荐，自动检测按 URL 和模型名猜，可能误判

详见 [API 配置详解](api-config.md)。

## 生成器与渠道：两层概念

配置 AI 源时经常撞见"生成器"和"渠道"两个词，它们**不是一回事**：

- **生成器（Generator）**：决定"谁去发这个请求、说哪种协议"。好比选择寄快递用哪家快递公司——每家有自己的一套单据格式。always-accompany 有 6 种生成器：proxy / claude / claude-api / gemini / grok / ollama。
- **渠道（Provider）**：**只属于 proxy 生成器**的二级概念。proxy 说的是"OpenAI 兼容格式"这门通用语，但各家服务商在这门通用语上各有"方言"（Claude 要提取 system 到顶层、DeepSeek R1 不收 system 角色、OpenAI 推理系要用 developer 角色……），渠道就是告诉 proxy"对面是哪家的方言"。渠道共 10 个值：claude / openrouter-claude / openrouter / gemini / deepseek-r1 / deepseek / qwen / openai-reasoning / openai / generic。

注意：**Ollama 不是渠道**。本地 Ollama 走独立的 ollama 生成器，Gemini 官方也有独立的 gemini 原生生成器——它们和"proxy + 渠道"是并列关系，不在渠道下拉里。

**在设置面板里你不用手动组合这两层**：面板的「API 类型」下拉已经把常用组合拍平成一层——选 `DeepSeek` 实际就是"proxy 生成器 + deepseek 渠道"，选 `Google Gemini（原生）` 就是 gemini 生成器，选 `Ollama（本地原生）` 就是 ollama 生成器。理解两层概念主要用于两件事：看懂"为什么渠道列表里没有 Ollama"，以及在完整管理页里按生成器配置更高级的选项。

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

## 生成器类型速查

6 种生成器各自对应的 API 协议（概念见上文「生成器与渠道」）：

| 生成器 | 协议 | 适用场景 |
|--------|------|---------|
| proxy | OpenAI Chat Completions | 最通用，大多数服务商走此通道（配合渠道二级适配） |
| claude-api | Anthropic Messages API | Claude 官方原生 API |
| gemini | Gemini API | Gemini 官方 API（AI 出图也走这里） |
| grok | Grok 逆向 API | xAI Grok |
| claude | Claude 逆向 API | Claude 逆向 |
| ollama | Ollama API | 本地 Ollama |

其中 **proxy** 是最常用的生成器，它支持所有 OpenAI 兼容格式的 API（包括 OpenRouter、DeepSeek、Qwen 等）。

## AI 出图

always-accompany 支持让 AI 在对话里直接生成图片，目前**仅 gemini 原生生成器**（Google Gemini 官方 API）具备这个能力。

开启方式（满足其一即可）：

- 模型名选带 `image-generation` 的 Gemini 出图模型
- 或在服务源的模型参数里显式配置 `responseModalities` 包含 `Image`

用起来是什么样：你在对话里让 AI 画图，AI 的回复气泡里会多出图片附件——和你自己上传给 AI 看的图片是**同一套附件通道**，点开即看、可下载。也就是说"你传图给 AI 看"和"AI 画图传回给你"是方向相反的两条路，但在界面上共用一个聊天附件入口。

> 提示：聊天附件（含你上传的图片）有 **25MB** 单文件上限，超过会直接拒绝。
>
> <!-- TODO配图: 对话中 AI 生成图片以附件形式出现在回复气泡里的截图 -->

其他生成器（proxy / claude-api 等）目前不支持出图；文生图服务商的独立出图 API 也暂未接入。

## 服务源是什么

always-accompany 本身不包含 AI 模型，它通过 API 调用外部 AI 服务。服务源就是这个 API 连接的配置——包括 API 地址、密钥、要使用的模型等信息。

打个比方：如果 always-accompany 是电话机，服务源就是电话卡。没有电话卡，电话机再好也打不出去。

## 快速导航

- [支持的 AI 服务商](providers.md) — 各服务商详情与配置要点
- [API 配置详解](api-config.md) — 配置字段说明
- [模型参数](model-params.md) — temperature、top_p 等参数说明
