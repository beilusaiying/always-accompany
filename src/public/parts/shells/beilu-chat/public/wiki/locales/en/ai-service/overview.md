# Adding AI Service Sources

Go to [Settings → AI Service Sources](beilu:settings/api) to add an API so always-accompany can connect to an AI.

## Quick Start

1. Open the [AI Service Sources](beilu:settings/api) settings panel
2. Enter the API URL
3. Enter the API Key
4. Select the model name
5. Select the Channel (Provider) to tell always-accompany which API provider this is
6. Save the configuration

### How to Choose a Channel

The Channel determines how always-accompany adapts the API message format:

- Using Claude → select `Anthropic Claude`
- Using OpenRouter to access Claude → select `OpenRouter -> Claude`
- Using a local model → select `Generic OpenAI Compatible`
- Not sure → select `Auto-detect` (not recommended; may misidentify)

See [API Configuration Details](api-config.md) for more.

## Configuring Multiple Service Sources

always-accompany supports configuring multiple Service Sources. You can:

- Bind different Service Sources to different modes (Claude for chat, GPT for coding)
- Bind different Service Sources to different characters
- Bind different Service Sources to different submodes

## Supported Providers

| Provider | Description |
|----------|-------------|
| OpenAI | GPT series models |
| Anthropic Claude | Claude series models (supports both official API and OpenAI-compatible endpoints) |
| Google Gemini | Gemini series models |
| xAI Grok | Grok series models (reverse API) |
| Ollama | Locally deployed open-source models |
| DeepSeek | DeepSeek series models |
| Qwen | Qwen series models |
| OpenRouter | Multi-model aggregation platform |
| Generic OpenAI Compatible | LM Studio / vLLM / llama.cpp and other local engines |

See [Supported AI Providers](providers.md) for details.

## Generator Types

always-accompany internally has multiple **generators (Service Generators)**, each corresponding to a class of API protocols:

| Generator | Protocol | Use Case |
|-----------|----------|----------|
| proxy | OpenAI Chat Completions | Most universal; the majority of providers go through this channel |
| claude-api | Anthropic Messages API | Claude official native API |
| gemini | Gemini API | Gemini official API |
| grok | Grok reverse API | xAI Grok |
| claude | Claude reverse API | Claude reverse |
| ollama | Ollama API | Local Ollama |

Among these, **proxy** is the most commonly used generator. It supports all OpenAI-compatible format APIs (including OpenRouter, DeepSeek, Qwen, etc.).

## What Is a Service Source

always-accompany itself does not include AI models; it calls external AI services via APIs. A Service Source is the configuration of this API connection — including the API URL, API Key, the model to use, and other information.

To put it simply: if always-accompany is a phone, the Service Source is the SIM card. Without a SIM card, the phone cannot make calls no matter how good it is.

## Quick Navigation

- [Supported AI Providers](providers.md) — Provider details and configuration tips
- [API Configuration Details](api-config.md) — Configuration field descriptions
- [Model Parameters](model-params.md) — temperature, top_p, and other parameter descriptions
