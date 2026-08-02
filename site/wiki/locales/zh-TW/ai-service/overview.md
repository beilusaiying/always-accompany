# 新增 AI 服務源

[設定 → AI服務源](beilu:settings/api)新增 API，讓 always-accompany 連接 AI。

## 快速開始

1. 進入[AI服務源](beilu:settings/api)設定面板
2. 填寫 API 位址（URL）
3. 填寫 API 金鑰（Key）
4. 選擇模型名稱
5. 選擇通道（Provider），告訴 always-accompany 這是哪家的 API
6. 儲存設定

### 通道怎麼選

通道決定 always-accompany 如何適配 API 的訊息格式：

- 用 Claude 就選 `Anthropic Claude`
- 用 OpenRouter 轉 Claude 就選 `OpenRouter -> Claude`
- 用本機模型就選 `通用 OpenAI 相容`
- 不確定就選 `自動偵測`（不推薦，可能誤判）

詳見 [API 設定詳解](api-config.md)。

## 設定多個服務源

always-accompany 支援設定多個服務源，你可以：

- 為不同模式繫結不同服務源（聊天用 Claude，程式碼用 GPT）
- 為不同角色繫結不同服務源
- 為不同子模式繫結不同服務源

## 支援的服務商

| 服務商 | 說明 |
|--------|------|
| OpenAI | GPT 系列模型 |
| Anthropic Claude | Claude 系列模型（支援官方 API 和 OpenAI 相容端點） |
| Google Gemini | Gemini 系列模型 |
| xAI Grok | Grok 系列模型（逆向 API） |
| Ollama | 本機部署的開源模型 |
| DeepSeek | DeepSeek 系列模型 |
| Qwen（通義） | 通義千問系列模型 |
| OpenRouter | 多模型聚合平台 |
| 通用 OpenAI 相容 | LM Studio / vLLM / llama.cpp 等本機引擎 |

詳見 [支援的 AI 服務商](providers.md)。

## 產生器類型

always-accompany 內部有多種 **產生器（Service Generator）**，每種對應一類 API 協定：

| 產生器 | 協定 | 適用情境 |
|--------|------|---------|
| proxy | OpenAI Chat Completions | 最通用，大多數服務商走此通道 |
| claude-api | Anthropic Messages API | Claude 官方原生 API |
| gemini | Gemini API | Gemini 官方 API |
| grok | Grok 逆向 API | xAI Grok |
| claude | Claude 逆向 API | Claude 逆向 |
| ollama | Ollama API | 本機 Ollama |

其中 **proxy** 是最常用的產生器，它支援所有 OpenAI 相容格式的 API（包括 OpenRouter、DeepSeek、Qwen 等）。

## 服務源是什麼

always-accompany 本身不包含 AI 模型，它透過 API 呼叫外部 AI 服務。服務源就是這個 API 連接的設定——包括 API 位址、金鑰、要使用的模型等資訊。

打個比方：如果 always-accompany 是電話機，服務源就是電話卡。沒有電話卡，電話機再好也打不出去。

## 快速導覽

- [支援的 AI 服務商](providers.md) — 各服務商詳情與設定要點
- [API 設定詳解](api-config.md) — 設定欄位說明
- [模型參數](model-params.md) — temperature、top_p 等參數說明
