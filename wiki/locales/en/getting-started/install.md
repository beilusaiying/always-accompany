# Configure AI Service Sources

AI service sources determine which AI provider and model you use.

## Adding a Service Source

[Settings → AI Service Sources](beilu:settings/api) → Click "Add":

1. Enter a name (anything you want, just for identification)
2. Enter the service URL (API endpoint)
3. Enter the API Key
4. Choose a channel (determines the request format)
5. Choose a model

## Supported Channels

| Channel | Use Case |
|---------|----------|
| openai | OpenAI official / any OpenAI-compatible relay |
| claude | Anthropic Claude API |
| gemini | Google Gemini |
| deepseek | DeepSeek |
| ollama | Local Ollama inference |
| openrouter | OpenRouter multi-model aggregation |
| generic | Other OpenAI-compatible services |

See [Supported AI Providers](beilu:wiki/ai-service/providers.md) for details.

## Multiple Service Sources

You can add multiple service sources:
- Bind different characters to different AIs (Character Card editor → AI source selection)
- Use different models for different modes (sub-modes can bind to independent API sources)
- Fall back to a backup when the primary source goes down

## Verification

After adding a source, send a test message. If you get a reply, you're all set. If not, check the error log in [Backend Monitor](beilu:settings/monitor).
