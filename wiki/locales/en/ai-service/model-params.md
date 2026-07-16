# Model Parameters

Model parameters (also called Sampling Parameters) control the style and behavior of AI text generation. Adjusting these parameters can make AI replies more creative, more precise, longer, or shorter. They can be adjusted in the parameters area of the [AI Service Sources](beilu:settings/api) panel.

## Parameter List

### Core Parameters

| Parameter | Range | Description |
|-----------|-------|-------------|
| temperature | 0 – 2.0 | Generation temperature. Higher values produce more random and varied replies; lower values produce more deterministic and conservative ones. 0 = almost always picks the most likely token |
| max_tokens | 1 – unlimited | Maximum output token count. Limits the maximum length of AI replies |
| top_p | 0 – 1.0 | Nucleus sampling. Only selects from tokens whose cumulative probability is within the top_p range. 1.0 = no restriction |

### Sampling Control Parameters

| Parameter | Range | Description |
|-----------|-------|-------------|
| top_k | 0+ | Top-K sampling. Only selects from the top K most probable tokens. 0 = no restriction |
| top_a | 0+ | Top-A sampling. Filters out tokens with probability less than the highest probability * top_a. OpenRouter exclusive |
| min_p | 0+ | Min-P sampling. Filters out tokens with probability less than the highest probability * min_p |

### Penalty Parameters

| Parameter | Range | Description |
|-----------|-------|-------------|
| frequency_penalty | -2.0 – 2.0 | Frequency penalty. Positive values reduce the repetition probability of already-appeared tokens; negative values encourage repetition |
| presence_penalty | -2.0 – 2.0 | Presence penalty. Positive values encourage talking about new topics; negative values encourage staying on existing topics |
| repetition_penalty | 0+ | Repetition penalty. 1.0 = no penalty; greater than 1 reduces repetition. Ollama / local model exclusive |

### Other Parameters

| Parameter | Description |
|-----------|-------------|
| seed | Random seed. Setting a fixed value makes results reproducible (-1 = random) |

## Parameter Priority

Model parameters in always-accompany come from multiple sources and override in the following priority:

```
Extension layer override (extension.beilu_model_params)
    ↑ overrides
Submode parameters
    ↑ overrides
Runtime parameter panel (runtimeParams)
    ↑ overrides
Preset-carried parameters (eng.modelParams)
    ↑ overrides
PARAM_SCHEMA defaults
```

- **Preset-carried parameters**: Parameter values included in the Preset JSON
- **Runtime parameter panel**: Values manually adjusted by the user in the parameter panel (persisted to runtime_params.json)
- **Submode parameters**: Parameters independently overridden by Code / Work submodes
- **Extension layer override**: Parameters dynamically injected at runtime by beilu-memory or other plugins

### Parameter Default Single Source

All parameter defaults are uniformly defined by `PARAM_SCHEMA`. The engine layer extracting defaults, the application layer fallback for empty values, and the frontend UI's min/max/step all share the same table, ensuring consistency.

## Provider Parameter Support

Different providers support different parameter subsets. always-accompany's parameter application layer (applyModelParams) automatically trims parameters according to each provider's API shape:

### OpenAI Shape (proxy / grok)

Supports all Sampling Parameters. top_a is only available in this shape (OpenRouter exclusive feature).

### Gemini Shape

Supports: temperature / top_p / top_k / max_tokens / frequency_penalty / presence_penalty / seed

Parameter names are automatically converted (e.g., `top_p` -> `topP`, `max_tokens` -> `maxOutputTokens`).

### Ollama Shape

Supports: temperature / top_p / top_k / repetition_penalty / max_tokens / min_p / seed

Parameter names are automatically converted (e.g., `repetition_penalty` -> `repeat_penalty`, `max_tokens` -> `num_predict`).

### Anthropic Shape (claude-api / claude)

Sampling Parameters are not sent by default. Newer Anthropic models (Opus 4.7+) do not support temperature / top_p / top_k (setting non-default values returns a 400 error). max_tokens is a required parameter.

## model_override (Model Switching)

`model_override` is not a Sampling Parameter, but it is passed through the same channel. It is used to switch AI models at runtime without changing the Service Source configuration:

- Submodes can each specify different models
- Sub-agent conversations can switch to different models

Resolution priority: `beilu_model_params.model_override` > Service Source `config.model`

## Sentinel Guard

The parameter application layer has a "sentinel guard" mechanism: when a parameter value equals the default (= user has not changed it), it is not sent to the API, avoiding unnecessary overriding of the provider's own default behavior.

For example:
- temperature = any user-set value is sent (including 0)
- top_p = not sent when 1.0 (1.0 is the default for most APIs)
- top_k = not sent when 0
- seed = not sent when -1

## Tuning Recommendations

| Scenario | Recommended Setting |
|----------|-------------------|
| Roleplay / creative writing | temperature 0.8 – 1.2, top_p 0.9 – 0.95 |
| Daily conversation | temperature 0.7 – 0.9 |
| Coding assistance | temperature 0.2 – 0.5 |
| Data analysis / precise answers | temperature 0 – 0.3 |
| Reduce repetition | frequency_penalty 0.3 – 0.8 |

## Navigation

- [API Configuration Details](api-config.md) — Service Source configuration
- [Preset Entry Structure](../presets/structure.md) — How Presets carry parameters
- [Presets and Mode Binding](../presets/mode-binding.md) — Submode parameter overrides
