# 支援的 AI 服務商

always-accompany 透過通道（Provider）識別不同的 AI 服務商。在[AI服務源](beilu:settings/api)面板選擇正確的通道可以確保訊息格式正確適配，避免 API 呼叫失敗。

### Anthropic Claude

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `claude` |
| 預設端點 | `https://api.anthropic.com/v1/chat/completions` |
| 注意事項 | temperature 與 top_p 不能同時設定（同傳回傳 400）；max_tokens 必填 |
| 適用產生器 | proxy（OpenAI 相容端點）/ claude-api（原生 Messages API） |

如果你使用 Claude 官方 API，有兩種接入方式：
- **proxy 產生器 + claude 通道**：走 OpenAI 相容端點，設定簡單
- **claude-api 產生器**：走 Anthropic 原生 `/v1/messages` 協定，支援更多 Claude 特性

使用中轉或反向代理時，直接替換 URL 位址即可。

### OpenRouter -> Claude

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `openrouter-claude` |
| 預設端點 | `https://openrouter.ai/api/v1/chat/completions` |
| 注意事項 | Claude 系約束同上（temperature/top_p 互斥） |

透過 OpenRouter 平台呼叫 Claude 模型時使用此通道。

### OpenRouter

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `openrouter` |
| 預設端點 | `https://openrouter.ai/api/v1/chat/completions` |
| 注意事項 | 無特殊限制 |

透過 OpenRouter 呼叫非 Claude 模型時使用。

### Google Gemini

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `gemini` |
| 預設端點 | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| 注意事項 | reasoning_effort 與 thinking_config 不能同傳 |
| 適用產生器 | proxy（OpenAI 相容端點）/ gemini（原生 API） |

### DeepSeek R1（推理系）

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `deepseek-r1` |
| 預設端點 | `https://api.deepseek.com/chat/completions` |
| 注意事項 | deepseek-reasoner 不支援 system 角色訊息（自動合併進首條 user） |

### DeepSeek

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `deepseek` |
| 預設端點 | `https://api.deepseek.com/chat/completions` |
| 注意事項 | 思考模式下 temperature/top_p/懲罰參數會被靜默忽略 |

### Qwen（通義 DashScope）

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `qwen` |
| 預設端點 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| 注意事項 | 開啟思考（enable_thinking）必須用串流；temperature 不能為 0；不同地區端點不同 |

### OpenAI 推理系（o1/o3/o4）

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `openai-reasoning` |
| 預設端點 | `https://api.openai.com/v1/chat/completions` |
| 注意事項 | 使用 `developer` 角色替代 `system` 角色 |

### OpenAI

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `openai` |
| 預設端點 | `https://api.openai.com/v1/chat/completions` |
| 注意事項 | 無特殊限制 |

### 通用 OpenAI 相容（本機/自部署）

| 項目 | 說明 |
|------|------|
| 通道識別碼 | `generic` |
| 預設端點 | `http://localhost:1234/v1/chat/completions` |
| 注意事項 | 適用於 LM Studio / vLLM / llama.cpp server / koboldcpp 等 |

## 通道的作用

選擇通道後，always-accompany 會自動進行針對性的訊息格式適配：

- **Claude 系**：頭部 system 訊息提取為頂層 system 欄位（Anthropic 協定要求）
- **Gemini**：合併頭部 system 為一條（相容層轉 systemInstruction）
- **DeepSeek R1**：system 訊息合併進首條 user（R1 不接受 system 角色）
- **OpenAI 推理系**：system 角色替換為 developer 角色
- **通用**：合併多條 system 為一條（本機推理引擎相容性）

## 自動偵測

如果不選擇通道（或選擇「自動偵測」），always-accompany 會根據 API URL 和模型名稱猜測服務商。但自動偵測可能誤判，建議手動選擇。

## Ollama（本機模型）

Ollama 走獨立的 ollama 產生器，不經 proxy。如果你在本機執行 Ollama，設定時選擇 Ollama 類型的服務源即可。Ollama 支援的取樣參數與 OpenAI 有所不同（例如使用 `repeat_penalty` 而非 `repetition_penalty`），always-accompany 會自動轉換參數名稱。

## 導覽

- [服務源概覽](overview.md) — 基礎概念
- [API 設定詳解](api-config.md) — 設定欄位詳解
- [模型參數](model-params.md) — 取樣參數說明
