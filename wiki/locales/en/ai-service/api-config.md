# API Configuration Details

Field descriptions for each AI Service Source in the [AI Service Sources](beilu:settings/api) panel.

## Panel Controls

The [AI Service Sources](beilu:settings/api) panel provides the following controls:

| Control | Description |
|---------|-------------|
| Service Source list | Left side displays added API sources; click to switch editing |
| New button | Create a new API Service Source |
| Delete button | Delete the currently selected Service Source |
| Config name | Text input; the display name of the Service Source |
| Channel dropdown | Multiple Channels available (OpenAI / Claude / Gemini / Ollama, etc.); determines message format adaptation |
| URL | Text input; the API endpoint URL |
| Key | Text input; the API Key (stored encrypted) |
| Model | Text input; the model name identifier |
| Fetch model list | Button; pulls the list of available models from the API for selection |
| Extended Thinking | Toggle; enable extended thinking capability (supported by some models) |
| Budget slider | Thinking budget control (available when Extended Thinking is enabled) |
| Save button | Save the current configuration |
| Chain-of-thought fold settings | Configure the display label and folding behavior for chain-of-thought content |

## Service Source Configuration Template

Each AI Service Source configuration contains the following fields:

| Field | Description | Required | Example |
|-------|-------------|----------|---------|
| name | Service Source name (for display) | Yes | `my-claude` |
| url | API endpoint URL | Yes | `https://api.anthropic.com/v1/chat/completions` |
| model | Model name to use | Yes | `claude-sonnet-4-20250514` |
| apikey | API Key | Yes | `sk-ant-...` |
| provider | Channel identifier | Recommended | `claude` |
| use_stream | Whether to use Streaming responses | No | `true` (default) |
| custom_headers | Custom request headers | No | `{"X-Custom": "value"}` |

## Field Details

### url (API Endpoint)

The API endpoint URL. Different providers and generators use different endpoint formats.

The default endpoint is automatically filled based on the selected Channel. If using a relay service or reverse proxy, replace it with the corresponding URL. Note that different generators correspond to different protocols:

- **proxy generator**: OpenAI Chat Completions format (`/v1/chat/completions`)
- **claude-api generator**: Anthropic Messages format (`/v1/messages`)
- **gemini generator**: Gemini native format
- **ollama generator**: Ollama format (`/api/chat`)

### model (Model Name)

The model identifier to call. Model names vary by provider:

| Provider | Model Name Examples |
|----------|-------------------|
| OpenAI | `gpt-4o`, `o3-mini` |
| Claude | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` |
| Gemini | `gemini-2.0-flash`, `gemini-2.5-pro` |
| DeepSeek | `deepseek-chat`, `deepseek-reasoner` |
| Qwen | `qwen-plus`, `qwen-max` |

The model name can be overridden at runtime by `model_override` in a submode.

### apikey (API Key)

The authentication key issued by the provider. Keys are stored encrypted in the configuration and are not exposed in plaintext in logs.

### provider (Channel)

Tells always-accompany which provider's API this is, determining the message format adaptation strategy. See [Supported AI Providers](providers.md) for details.

It is strongly recommended to manually select a Channel rather than relying on auto-detection. Auto-detection (leaving blank or selecting "Auto-detect") guesses based on the URL and model name and may misidentify, causing API call failures.

### use_stream (Streaming)

Whether to use SSE Streaming responses. Enabled by default.

- **Enabled**: AI replies appear word by word for a better experience
- **Disabled**: Waits for the complete reply before displaying it all at once

Streaming must be enabled in certain scenarios:
- Qwen's enable_thinking feature
- Inference mode on some local engines

### custom_headers (Custom Request Headers)

A JSON object for additional HTTP request headers. Commonly used for:

- OpenRouter's `HTTP-Referer` and `X-Title`
- Auth headers for corporate intranets
- Custom authentication for reverse proxies

### roleReminding (Role Reminding)

Boolean; whether to enable role reminding in messages sent to the AI. When enabled, the system inserts role reminding text at appropriate positions to help the AI maintain character consistency. Enabled by default.

### ignoreFiles (Ignore Attachments)

Boolean; whether to ignore file content attached to conversations. Enable this to avoid API errors when using models that do not support file/image input.

## Multi-Source Management

### Character-Level Binding

Each character can be bound to an independent AI Service Source. After specifying a Service Source in the character settings, conversations with that character will use the specified Service Source, unaffected by global settings.

### Submode Override

Each submode in Code and Work modes can independently override the model name and Sampling Parameters. This allows the same Service Source to use different models at different work stages (e.g., a smaller model for simple tasks, a larger model for complex analysis).

## Security Notes

- API Keys are transmitted over HTTPS and stored encrypted on the server
- Local deployments (Ollama / LM Studio) do not require API Keys
- In multi-user scenarios, each user's Service Source configuration is independently isolated

## Navigation

- [Service Source Overview](overview.md) — Basic concepts
- [Supported AI Providers](providers.md) — Provider details
- [Model Parameters](model-params.md) — Sampling Parameter descriptions
