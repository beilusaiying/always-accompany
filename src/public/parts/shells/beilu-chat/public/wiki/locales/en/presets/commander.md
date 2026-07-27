# Commander Mode

Commander Mode is an advanced operating mode of the Preset engine. In this mode, the Preset takes over the assembly of the entire message sequence — instead of each provider assembling on its own, the Preset engine produces the final message list sent to the AI using a **five-segment assembly** rule.

In normal mode, a Preset only provides "instruction fragments," and the provider decides where to place them. In Commander Mode, the Preset acts as the "commander-in-chief," precisely controlling the position of every piece of content.

## Five-Segment Assembly

Commander Mode divides the final messages into five segments, arranged in a fixed order:

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber wiki-box-full"><b>1. beforeChat (Header Preset)</b><small>beilu_preset_before — System instructions, character settings, World Book</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. injectionAbove (@D>=1 Injection)</b><small>beilu_injection_above — Injection entries with depth >= 1</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>3. chatSegment (Chat History)</b><small>provider-built — Core conversation message sequence</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>4. injectionBelow (@D=0 Injection)</b><small>beilu_injection_below — Memory, real-time context, etc.</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red wiki-box-full"><b>5. afterChat (Tail Preset)</b><small>beilu_preset_after — Jailbreak, format requirements, etc.</small></div>
</div>

### Segment Responsibilities

| Segment | Field Name | Content | Position Semantics |
|---------|------------|---------|-------------------|
| beforeChat | beilu_preset_before | System instructions, character settings, World Book, etc. | Instructions the AI sees first |
| injectionAbove | beilu_injection_above | Injection entries with depth >= 1 | Above chat history |
| chatSegment | _(provider-built)_ | Chat history message sequence | Core conversation |
| injectionBelow | beilu_injection_below | Injection entries with depth = 0 (memory, real-time context, etc.) | Below chat history, close to the latest message |
| afterChat | beilu_preset_after | Tail instructions (jailbreak, format requirements, etc.) | Instructions the AI sees last |

## Shared Layer Implementation

The five-segment assembly logic is centralized in `_shared/commanderAssembly.mjs`, shared by all 6 providers (proxy / grok / claude / claude-api / ollama / gemini).

### Why Parameterized Instead of Direct Returns

The six providers have fundamentally different message shapes:

| Provider | Message Shape |
|----------|--------------|
| proxy | OpenAI standard messages (with metadata markers) |
| grok / claude | Simple `{role, content}` |
| ollama | `{role, content}` + image fields |
| gemini | Gemini parts shape (role maps to model) |
| claude-api | Anthropic native format + top-level system field |

Therefore, the shared layer uses a parameterized design:

- `mapMsg`: Each provider supplies its own "segment message -> target shape" mapping function
- `chatSegment`: Chat message segment pre-built by each provider
- `extractSystem`: Anthropic-family providers need to extract before/after segments into a top-level system field
- `cacheBoundary`: Whether to apply cache boundary optimization

### Cache Boundary Optimization

When the first message in injectionBelow exceeds 1000 characters (typically memory data), the shared layer moves it from the bottom to just before the second-to-last message in the chat segment. The purpose is to leverage the API's caching mechanism — memory data is relatively stable, and placing it near the cache boundary increases cache hit rates.

## Gating and Validation

### Commander Mode Gating

When a Preset entry contains the `commander_mode` marker, the provider enters the Commander branch. Gating uses dual-value AND logic — both the Preset marker must exist and there must be actual segment content.

### Schema Validation

The shared layer calls `validateCommanderPreset()` to verify the existence and types of Preset segment fields. The four segment fields (beilu_preset_before / beilu_injection_above / beilu_injection_below / beilu_preset_after) should be array types. Validation errors only produce warnings without interrupting execution (fail-safe), so message output is not affected.

## Commander Output in TweakPrompt

The Preset engine produces Commander segment content during TweakPrompt Round 2:

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>1. buildAllEntries()</b><small>Engine produces four segment outputs</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>2. Write to extension</b><small>beforeChat / afterChat → beilu_preset_before / beilu_preset_after</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>3. Write to extension</b><small>injectionAbove / injectionBelow → beilu_injection_above / beilu_injection_below</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>4. Provider StructCall assembly</b><small>Read from extension → assembleCommanderMessages()</small></div>
</div>

## When to Use Commander Mode

| Scenario | Needed? |
|----------|---------|
| Simple conversation | No — normal mode is sufficient |
| Roleplay, need precise Prompt position control | Recommended |
| Custom complex Prompt architecture | Required |
| Code / Work Mode | Already auto-enabled by built-in Presets |

## Navigation

- [Preset System Overview](overview.md) — Preset fundamentals
- [Preset Entry Structure](structure.md) — Entry field reference
- [Message Pipeline](../developer/message-pipeline.md) — Complete message flow chain
