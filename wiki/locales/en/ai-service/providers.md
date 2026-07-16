# Supported AI Providers

always-accompany identifies different AI providers through Channels (Providers). Selecting the correct Channel in the [AI Service Sources](beilu:settings/api) panel ensures proper message format adaptation and prevents API call failures.

### Anthropic Claude

| Item | Description |
|------|-------------|
| Channel identifier | `claude` |
| Default endpoint | `https://api.anthropic.com/v1/chat/completions` |
| Notes | temperature and top_p cannot be set simultaneously (sending both returns 400); max_tokens is required |
| Applicable generators | proxy (OpenAI-compatible endpoint) / claude-api (native Messages API) |

If you use the Claude official API, there are two connection methods:
- **proxy generator + claude Channel**: Uses the OpenAI-compatible endpoint; simpler to configure
- **claude-api generator**: Uses the Anthropic native `/v1/messages` protocol; supports more Claude features

When using a relay or reverse proxy, simply replace the URL.

### OpenRouter -> Claude

| Item | Description |
|------|-------------|
| Channel identifier | `openrouter-claude` |
| Default endpoint | `https://openrouter.ai/api/v1/chat/completions` |
| Notes | Same Claude-family constraints as above (temperature/top_p are mutually exclusive) |

Use this Channel when calling Claude models through the OpenRouter platform.

### OpenRouter

| Item | Description |
|------|-------------|
| Channel identifier | `openrouter` |
| Default endpoint | `https://openrouter.ai/api/v1/chat/completions` |
| Notes | No special restrictions |

Use this when calling non-Claude models through OpenRouter.

### Google Gemini

| Item | Description |
|------|-------------|
| Channel identifier | `gemini` |
| Default endpoint | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| Notes | reasoning_effort and thinking_config cannot be sent simultaneously |
| Applicable generators | proxy (OpenAI-compatible endpoint) / gemini (native API) |

### DeepSeek R1 (Reasoning Series)

| Item | Description |
|------|-------------|
| Channel identifier | `deepseek-r1` |
| Default endpoint | `https://api.deepseek.com/chat/completions` |
| Notes | deepseek-reasoner does not support system role messages (automatically merged into the first user message) |

### DeepSeek

| Item | Description |
|------|-------------|
| Channel identifier | `deepseek` |
| Default endpoint | `https://api.deepseek.com/chat/completions` |
| Notes | In thinking mode, temperature/top_p/penalty parameters are silently ignored |

### Qwen (DashScope)

| Item | Description |
|------|-------------|
| Channel identifier | `qwen` |
| Default endpoint | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| Notes | Enabling thinking (enable_thinking) requires Streaming; temperature cannot be 0; endpoints differ by region |

### OpenAI Reasoning Series (o1/o3/o4)

| Item | Description |
|------|-------------|
| Channel identifier | `openai-reasoning` |
| Default endpoint | `https://api.openai.com/v1/chat/completions` |
| Notes | Uses the `developer` role instead of the `system` role |

### OpenAI

| Item | Description |
|------|-------------|
| Channel identifier | `openai` |
| Default endpoint | `https://api.openai.com/v1/chat/completions` |
| Notes | No special restrictions |

### Generic OpenAI Compatible (Local/Self-hosted)

| Item | Description |
|------|-------------|
| Channel identifier | `generic` |
| Default endpoint | `http://localhost:1234/v1/chat/completions` |
| Notes | Suitable for LM Studio / vLLM / llama.cpp server / koboldcpp, etc. |

## What Channels Do

After selecting a Channel, always-accompany automatically performs targeted message format adaptation:

- **Claude family**: Extracts the leading system message into a top-level system field (required by the Anthropic protocol)
- **Gemini**: Merges leading system messages into one (compatibility layer converts to systemInstruction)
- **DeepSeek R1**: Merges system messages into the first user message (R1 does not accept the system role)
- **OpenAI Reasoning Series**: Replaces the system role with the developer role
- **Generic**: Merges multiple system messages into one (local inference engine compatibility)

## Auto-detect

If you do not select a Channel (or select "Auto-detect"), always-accompany will guess the provider based on the API URL and model name. However, auto-detection may misidentify; manual selection is recommended.

## Ollama (Local Models)

Ollama uses a dedicated ollama generator and does not go through proxy. If you run Ollama locally, select the Ollama type Service Source when configuring. Ollama supports Sampling Parameters that differ from OpenAI's (e.g., it uses `repeat_penalty` instead of `repetition_penalty`); always-accompany automatically converts parameter names.

## Navigation

- [Service Source Overview](overview.md) — Basic concepts
- [API Configuration Details](api-config.md) — Configuration field details
- [Model Parameters](model-params.md) — Sampling Parameter descriptions
