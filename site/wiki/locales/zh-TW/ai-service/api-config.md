# API 設定詳解

每個 AI 服務源在[AI服務源](beilu:settings/api)面板中的設定欄位說明。

## 面板操作

[AI 服務源](beilu:settings/api)面板提供以下操作：

| 控制項 | 說明 |
|------|------|
| 服務源列表 | 左側顯示已新增的 API 源，點擊切換編輯 |
| 新建按鈕 | 建立新的 API 服務源 |
| 刪除按鈕 | 刪除目前選中的服務源 |
| 設定名稱 | 文字輸入，服務源的顯示名稱 |
| 通道下拉 | 多種通道可選（OpenAI / Claude / Gemini / Ollama 等），決定訊息格式適配 |
| URL | 文字輸入，API 端點位址 |
| Key | 文字輸入，API 金鑰（加密儲存） |
| 模型 | 文字輸入，模型名稱識別碼 |
| 取得模型列表 | 按鈕，從 API 拉取可用模型列表供選擇 |
| Extended Thinking | 開關，啟用擴展思考能力（部分模型支援） |
| Budget 滑桿 | 思考預算控制（Extended Thinking 開啟後可用） |
| 儲存按鈕 | 儲存目前設定 |
| 思維鏈摺疊設定 | 設定思維鏈內容的顯示標籤和摺疊行為 |

## 服務源設定範本

每個 AI 服務源的設定包含以下欄位：

| 欄位 | 說明 | 必填 | 範例 |
|------|------|------|------|
| name | 服務源名稱（顯示用） | 是 | `my-claude` |
| url | API 端點位址 | 是 | `https://api.anthropic.com/v1/chat/completions` |
| model | 使用的模型名稱 | 是 | `claude-sonnet-4-20250514` |
| apikey | API 金鑰 | 是 | `sk-ant-...` |
| provider | 通道識別碼 | 推薦 | `claude` |
| use_stream | 是否使用串流回應 | 否 | `true`（預設） |
| custom_headers | 自訂請求標頭 | 否 | `{"X-Custom": "value"}` |

## 欄位詳解

### url（API 端點）

API 端點位址。不同服務商和產生器使用不同的端點格式。

預設端點會根據選擇的通道自動填充。如果使用中轉服務或反向代理，替換為對應位址即可。注意不同產生器對應不同協定：

- **proxy 產生器**：OpenAI Chat Completions 格式（`/v1/chat/completions`）
- **claude-api 產生器**：Anthropic Messages 格式（`/v1/messages`）
- **gemini 產生器**：Gemini 原生格式
- **ollama 產生器**：Ollama 格式（`/api/chat`）

### model（模型名稱）

要呼叫的模型識別碼。不同服務商的模型名稱不同：

| 服務商 | 模型名稱範例 |
|--------|-------------|
| OpenAI | `gpt-4o`, `o3-mini` |
| Claude | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` |
| Gemini | `gemini-2.0-flash`, `gemini-2.5-pro` |
| DeepSeek | `deepseek-chat`, `deepseek-reasoner` |
| Qwen | `qwen-plus`, `qwen-max` |

模型名稱可以在子模式或執行階段被 `model_override` 覆蓋。

### apikey（API 金鑰）

服務商核發的認證金鑰。金鑰在設定中加密儲存，不會以明文暴露在日誌中。

### provider（通道）

告訴 always-accompany 這是哪家服務商的 API，決定訊息格式適配策略。詳見 [支援的 AI 服務商](providers.md)。

強烈建議手動選擇通道而非依賴自動偵測。自動偵測（留空或選「自動偵測」）會根據 URL 和模型名猜測，可能誤判導致 API 呼叫失敗。

### use_stream（串流回應）

是否使用 SSE 串流回應。預設開啟。

- **開啟**：AI 的回覆逐字出現，體驗更好
- **關閉**：等待完整回覆後一次性顯示

某些情境必須開啟串流：
- Qwen 的 enable_thinking 功能
- 部分本機引擎的推理模式

### custom_headers（自訂請求標頭）

JSON 物件，額外的 HTTP 請求標頭。通常用於：

- OpenRouter 的 `HTTP-Referer` 和 `X-Title`
- 企業內網的認證標頭
- 反向代理的自訂鑑權

### roleReminding（角色提醒）

布林值，是否在傳送給 AI 的訊息中啟用角色提醒（role reminding）。啟用後，系統會在合適的位置插入角色提醒文字，幫助 AI 保持角色一致性。預設開啟。

### ignoreFiles（忽略附件）

布林值，是否忽略對話中附帶的檔案內容。某些模型不支援檔案/圖片輸入時，開啟此項可以避免 API 錯誤。

## 多服務源管理

### 角色級繫結

每個角色可以繫結獨立的 AI 服務源。在角色設定中指定服務源後，與該角色的對話將使用指定的服務源，不受全域設定影響。

### 子模式覆蓋

Code 和 Work 模式的每個子模式可以獨立覆蓋模型名稱和取樣參數。這使得同一服務源在不同工作階段可以使用不同模型（例如簡單任務用小模型，複雜分析用大模型）。

## 安全注意事項

- API 金鑰透過 HTTPS 傳輸，在伺服端加密儲存
- 本機部署（Ollama / LM Studio）不需要 API 金鑰
- 多使用者情境下，每個使用者的服務源設定獨立隔離

## 導覽

- [服務源概覽](overview.md) — 基礎概念
- [支援的 AI 服務商](providers.md) — 各服務商詳情
- [模型參數](model-params.md) — 取樣參數說明
