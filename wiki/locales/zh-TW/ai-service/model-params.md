# 模型參數

模型參數（也叫取樣參數）控制 AI 產生文字的風格和行為。調整這些參數可以讓 AI 的回覆更有創意、更精確、更長或更短。可在[AI服務源](beilu:settings/api)面板的參數區域調整。

## 參數列表

### 核心參數

| 參數 | 範圍 | 說明 |
|------|------|------|
| temperature | 0 - 2.0 | 產生溫度。越高回覆越隨機多變，越低越確定保守。0 = 幾乎總是選最可能的詞 |
| max_tokens | 1 - 無上限 | 最大輸出 token 數。限制 AI 回覆的最大長度 |
| top_p | 0 - 1.0 | 核取樣。只從累積機率前 top_p 的詞中選擇。1.0 = 不限制 |

### 取樣控制參數

| 參數 | 範圍 | 說明 |
|------|------|------|
| top_k | 0+ | Top-K 取樣。只從機率最高的前 K 個詞中選擇。0 = 不限制 |
| top_a | 0+ | Top-A 取樣。過濾掉機率低於最高機率 * top_a 的詞。OpenRouter 專屬 |
| min_p | 0+ | Min-P 取樣。過濾掉機率低於最高機率 * min_p 的詞 |

### 懲罰參數

| 參數 | 範圍 | 說明 |
|------|------|------|
| frequency_penalty | -2.0 - 2.0 | 頻率懲罰。正值降低已出現詞的重複機率，負值鼓勵重複 |
| presence_penalty | -2.0 - 2.0 | 存在懲罰。正值鼓勵談論新話題，負值鼓勵圍繞已有話題 |
| repetition_penalty | 0+ | 重複懲罰。1.0 = 無懲罰，大於 1 減少重複。Ollama / 本機模型專用 |

### 其他參數

| 參數 | 說明 |
|------|------|
| seed | 隨機種子。設定固定值可以使結果可複現（-1 = 隨機） |

## 參數優先順序

always-accompany 中模型參數有多個來源，按以下優先順序覆蓋：

```
擴充層覆蓋 (extension.beilu_model_params)
    ↑ 覆蓋
子模式參數
    ↑ 覆蓋
執行階段參數面板 (runtimeParams)
    ↑ 覆蓋
預設集攜帶參數 (eng.modelParams)
    ↑ 覆蓋
PARAM_SCHEMA 預設值
```

- **預設集攜帶參數**：預設集 JSON 中自帶的參數值
- **執行階段參數面板**：使用者在參數面板中手動調整的值（持久化到 runtime_params.json）
- **子模式參數**：Code / Work 子模式獨立覆蓋的參數
- **擴充層覆蓋**：由 beilu-memory 或其他外掛在執行階段動態注入的參數

### 參數缺省單源

所有參數的預設值統一由 `PARAM_SCHEMA` 定義。引擎層提取預設值、應用層空窗兜底、前端 UI 的 min/max/step 三處共用同一張表，確保一致性。

## 各服務商的參數支援

不同服務商支援的參數子集不同。always-accompany 的參數應用層（applyModelParams）按服務商的 API 形狀自動裁剪：

### OpenAI 形狀（proxy / grok）

支援全部取樣參數。top_a 僅在此形狀可用（OpenRouter 專屬功能）。

### Gemini 形狀

支援：temperature / top_p / top_k / max_tokens / frequency_penalty / presence_penalty / seed

參數名自動轉換（例如 `top_p` -> `topP`，`max_tokens` -> `maxOutputTokens`）。

### Ollama 形狀

支援：temperature / top_p / top_k / repetition_penalty / max_tokens / min_p / seed

參數名自動轉換（例如 `repetition_penalty` -> `repeat_penalty`，`max_tokens` -> `num_predict`）。

### Anthropic 形狀（claude-api / claude）

預設不傳取樣參數。Anthropic 新版模型（Opus 4.7+）不支援 temperature / top_p / top_k（設非預設值會回傳 400 錯誤）。max_tokens 為必填參數。

## model_override（模型切換）

`model_override` 不是取樣參數，但透過同一通道傳遞。它用於在執行階段切換 AI 模型，而不改變服務源設定：

- 子模式可以各自指定不同模型
- 分身對話可以切換到不同模型

解析優先順序：`beilu_model_params.model_override` > 服務源 `config.model`

## 哨兵守衛

參數應用層有「哨兵守衛」機制：當參數值等於預設值（= 使用者未改）時，不下發給 API，避免無謂覆蓋服務商自身的預設行為。

例如：
- temperature = 使用者設的任何值都下發（含 0）
- top_p = 1.0 時不下發（1.0 是多數 API 的預設值）
- top_k = 0 時不下發
- seed = -1 時不下發

## 調參建議

| 情境 | 推薦設定 |
|------|---------|
| 角色扮演 / 創意寫作 | temperature 0.8 - 1.2，top_p 0.9 - 0.95 |
| 日常對話 | temperature 0.7 - 0.9 |
| 程式碼輔助 | temperature 0.2 - 0.5 |
| 資料分析 / 精確回答 | temperature 0 - 0.3 |
| 減少重複 | frequency_penalty 0.3 - 0.8 |

## 導覽

- [API 設定詳解](api-config.md) — 服務源設定
- [預設集條目結構](../presets/structure.md) — 預設集如何攜帶參數
- [預設集與模式聯動](../presets/mode-binding.md) — 子模式參數覆蓋
