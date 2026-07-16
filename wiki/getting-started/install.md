# 配置 AI 服务源

AI 服务源决定你用哪家 AI、用哪个模型。

## 添加服务源

[设置 → AI服务源](beilu:settings/api) → 点「添加」：

1. 填名称（自己起，用来区分）
2. 填服务地址（API endpoint）
3. 填 API Key
4. 选渠道（决定请求格式）
5. 选模型

## 支持的渠道

| 渠道 | 适用场景 |
|------|---------|
| openai | OpenAI 官方 / 任何 OpenAI 兼容中转 |
| claude | Anthropic Claude API |
| gemini | Google Gemini |
| deepseek | DeepSeek |
| ollama | 本地 Ollama 推理 |
| openrouter | OpenRouter 多模型聚合 |
| generic | 其他 OpenAI 兼容服务 |

详见 [支持的 AI 服务商](beilu:wiki/ai-service/providers.md)。

## 多服务源

可以添加多个服务源：
- 不同角色绑不同 AI（角色卡编辑 → AI源选择）
- 不同模式用不同模型（子模式可独立绑定API源）
- 主源挂了切备用

## 验证

添加后发一条消息试试，能回复就配好了。回复不了看 [后台监控](beilu:settings/monitor) 的错误日志。
