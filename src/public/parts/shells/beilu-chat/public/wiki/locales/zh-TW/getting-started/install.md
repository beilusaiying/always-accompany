# 設定 AI 服務源

AI 服務源決定你用哪家 AI、用哪個模型。

## 新增服務源

[設定 → AI服務源](beilu:settings/api) → 點「新增」：

1. 填名稱（自己取，用來區分）
2. 填服務位址（API endpoint）
3. 填 API Key
4. 選頻道（決定請求格式）
5. 選模型

## 支援的頻道

| 頻道 | 適用情境 |
|------|---------|
| openai | OpenAI 官方 / 任何 OpenAI 相容中轉 |
| claude | Anthropic Claude API |
| gemini | Google Gemini |
| deepseek | DeepSeek |
| ollama | 本機 Ollama 推理 |
| openrouter | OpenRouter 多模型聚合 |
| generic | 其他 OpenAI 相容服務 |

詳見 [支援的 AI 服務商](beilu:wiki/ai-service/providers.md)。

## 多服務源

可以新增多個服務源：
- 不同角色綁不同 AI（角色卡編輯 → AI源選擇）
- 不同模式用不同模型（子模式可獨立綁定 API 源）
- 主源掛了切備用

## 驗證

新增後發一則訊息試試，能回覆就設定好了。無法回覆請查看 [後台監控](beilu:settings/monitor) 的錯誤日誌。
