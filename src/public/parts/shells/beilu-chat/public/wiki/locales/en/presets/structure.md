# Preset Entry Structure

The Preset engine (PresetEngine) is compatible with the SillyTavern Preset format. A Preset JSON file consists of two parts: the **entry list** (prompts) and the **sort table** (prompt_order). The engine parses these data, sorts them according to rules, and produces four message segments (beforeChat / afterChat / injectionAbove / injectionBelow) for downstream provider assembly.

## Preset JSON Structure

<div class="wiki-grid wiki-grid-3">
<div class="wiki-group" style="grid-column: span 3">
<div class="wiki-group-title">prompts[] — Entry Array</div>
<div class="wiki-grid wiki-grid-4">
<div class="wiki-card"><div class="wiki-card-title">identifier</div><div class="wiki-card-desc">Unique identifier</div></div>
<div class="wiki-card"><div class="wiki-card-title">name</div><div class="wiki-card-desc">Display name</div></div>
<div class="wiki-card"><div class="wiki-card-title">role</div><div class="wiki-card-desc">Message role (system / user / assistant)</div></div>
<div class="wiki-card"><div class="wiki-card-title">content</div><div class="wiki-card-desc">Entry text content (supports Macros)</div></div>
<div class="wiki-card"><div class="wiki-card-title">injection_position</div><div class="wiki-card-desc">Injection position (0=afterChat / 1=beforeChat)</div></div>
<div class="wiki-card"><div class="wiki-card-title">injection_depth</div><div class="wiki-card-desc">Injection depth (insertion point in chat history)</div></div>
<div class="wiki-card"><div class="wiki-card-title">enabled</div><div class="wiki-card-desc">Whether the entry is enabled</div></div>
<div class="wiki-card"><div class="wiki-card-title">marker</div><div class="wiki-card-desc">Whether it is a built-in marker (e.g., chatHistory)</div></div>
</div>
</div>
</div>

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">prompt_order[] — Sort Order</div>
<div class="wiki-card"><div class="wiki-card-title">character_id</div><div class="wiki-card-desc">100000 = system level / 100001 = user level</div></div>
<div class="wiki-card"><div class="wiki-card-title">order[]</div><div class="wiki-card-desc">Identifier arrangement for that level</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">model_params — Model Parameters (optional)</div>
<div class="wiki-card"><div class="wiki-card-desc">Temperature, sampling, and other model parameters carried by the Preset</div></div>
</div>
</div>

## Entry Categories

### Built-in Marker Entries (Marker)

The engine predefines 12 built-in markers that form the structural backbone of a Preset:

| Marker | Purpose | Macro Expansion Target |
|--------|---------|----------------------|
| main | Main system Prompt | - |
| nsfw | NSFW-related instructions | - |
| jailbreak | Jailbreak / unlock instructions | - |
| chatHistory | Chat history divider | _chat_log |
| charDescription | Character description | char_prompt |
| charPersonality | Character personality | char_personality |
| scenario | Scenario setting | scenario |
| personaDescription | User Persona description | user_prompt |
| worldInfoBefore | World Book (before) | world_prompt |
| worldInfoAfter | World Book (after) | world_prompt_after |
| dialogueExamples | Dialogue examples | dialogue_examples |
| enhanceDefinitions | Enhanced definitions | - |

In Commander Mode, Marker entries expand into the actual content of their corresponding modules (injected via the Macro environment env).

### User-Defined Entries

Users can freely add entries as long as the identifier does not conflict with built-in markers. Use injection_position and injection_depth to control where the entry appears in the final messages.

## Sort Rules

### Two-Level Sorting

Presets define sorting through prompt_order:

- **System level** (character_id = 100000): Contains built-in Markers and system instructions, forming the Prompt backbone
- **User level** (character_id = 100001): User-added custom entries

### Injection Position

| injection_position | Meaning | Placement |
|-------------------|---------|-----------|
| 0 | afterChat | After chat history (tail Preset) |
| 1 | beforeChat | Before chat history (header Preset) |

### Injection Depth (injection_depth)

Injection depth determines where an entry is inserted within chat history:

- **Depth 0**: At the very bottom, right next to the latest message
- **Depth 4** (ST default): 4 messages up from the bottom
- **Depth N**: N messages up from the bottom

The smaller the depth, the closer the entry is to the latest conversation, making it easier for the AI to "see" and follow.

## Engine Workflow

The PresetEngine's core method `buildAllEntries()` works through these steps:

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>1. Iterate prompt_order</b><small>Process in system level → user level order</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>2. Filter disabled entries</b><small>Skip entries with enabled = false</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>3. Marker expansion</b><small>Built-in marker entries expand into actual content from the Macro environment</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>4. Macro substitution</b><small>Custom entries go through evaluateMacros</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>5. Group by injection_position</b><small>→ beforeChat / afterChat</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>6. Split by injection_depth</b><small>depth >= 1 → injectionAbove / depth = 0 → injectionBelow</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red"><b>7. Return four-segment output</b><small>Consumed by TweakPrompt</small></div>
</div>

## Macro Substitution

Entry content supports Macro syntax. During the buildAllEntries stage, the engine calls `evaluateMacros` to perform substitutions on entry text. Common Macros include:

- `{{char}}` — Current character name
- `{{user}}` — Current user name
- `{{time}}` — Current time
- Custom variable Macros

See [Macro System](../macros/overview.md) for details.

## Model Parameter Extraction

Presets can carry model parameters. The engine extracts the following canonical parameters from Preset data via `extractModelParams`:

| Parameter | Description | Default |
|-----------|-------------|---------|
| temperature | Generation temperature | Defined by PARAM_SCHEMA |
| top_p | Nucleus sampling | Defined by PARAM_SCHEMA |
| top_k | Top-K sampling | Defined by PARAM_SCHEMA |
| max_tokens | Maximum output tokens | Defined by PARAM_SCHEMA |
| frequency_penalty | Frequency penalty | Defined by PARAM_SCHEMA |
| presence_penalty | Presence penalty | Defined by PARAM_SCHEMA |
| repetition_penalty | Repetition penalty | Defined by PARAM_SCHEMA |
| min_p | Min-P sampling | Defined by PARAM_SCHEMA |
| top_a | Top-A sampling | Defined by PARAM_SCHEMA |
| seed | Random seed | Defined by PARAM_SCHEMA |

All defaults are defined uniformly by `paramSchema.mjs`'s PARAM_SCHEMA, ensuring the engine layer, application layer, and frontend UI all share a single source.

## Navigation

- [Preset System Overview](overview.md) — Preset fundamentals
- [Commander Mode](commander.md) — Preset takes over message assembly
