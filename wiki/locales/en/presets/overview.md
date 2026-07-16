# Preset System

Select a Preset from the Left Panel dropdown, and the AI immediately adopts a different behavior set — Chat Mode uses a chat Preset, Code Mode uses a coding Preset, effective the moment you switch.

## Switching Presets

In the conversation interface's Preset selector, click to switch the current Preset. The change takes effect immediately — the very next message will use the new Preset.

## Enabling / Disabling Entries

Through the beilu-toggle plugin, check or uncheck individual entries in the Preset panel to adjust the instructions the AI receives in real time.

## Importing Presets

In the Preset management panel, click Import and select a SillyTavern-format JSON file. always-accompany is fully compatible with the SillyTavern Preset format, and you can also create Presets from scratch.

## Preset Categories

always-accompany categorizes Presets by purpose (called buckets):

| Category | Purpose | Typical Presets |
|----------|---------|-----------------|
| Code | Coding assistance | Code review, coding assistant, IDE instructions |
| Work | Workflows | Task management, document writing, data analysis |
| Clone | Roleplay | Character Card adaptation, conversation style |
| General | Any scenario | Custom Presets |

See [Preset Categories & Selection](categories.md) for details.

## Preset-Mode Interaction

Each mode ([Chat Mode](beilu:mode/chat) / Code / [Work Mode](beilu:mode/work) / [Bot Management](beilu:mode/bot)) can bind a different Preset. When you switch modes, the system automatically loads the Preset bound to that mode:

- Chat Mode with a chat Preset → the AI behaves like a companion character
- Code Mode with a coding Preset → the AI behaves like a coding assistant
- Work Mode with a work Preset → the AI behaves like a work partner

See [Preset-Mode Binding](mode-binding.md) for details.

## Deep Dive

### What a Preset Contains

A Preset consists of multiple **entries (Prompt Entries)**, each being a text segment with control attributes:

| Component | Description |
|-----------|-------------|
| Entry content | The actual text sent to the AI (system instructions, character directives, style requirements, etc.) |
| Sort order | The entry's position in the Prompt (earlier entries receive higher AI priority) |
| Enabled state | Each entry can be individually toggled on or off |
| Injection depth | Where the entry is inserted into chat history (depth 0 = bottom, depth 4 = 4 messages up from the bottom) |
| Role marker | The identity under which the entry is sent (system / user / assistant) |

### What a Preset Does

When you send a message, always-accompany does not simply forward your message to the AI. Behind the scenes, the Preset engine assembles character settings, system instructions, World Book entries, chat history, plugin Prompts, and more into a complete Prompt according to the entry order defined by the Preset, and only then sends it to the AI.

### Presets and Model Parameters

A Preset can carry model parameters (temperature, top_p, etc.) in addition to Prompt entries. When a Preset is loaded, these parameters take effect as well, giving each Preset its own generation style.

Parameter priority: Preset parameters < runtime parameter panel < extension-layer model parameter overrides

See [Model Parameters](../ai-service/model-params.md) for details. You can also adjust parameters in the [AI Service Source](beilu:settings/api) panel.

## Navigation

- [Preset Categories & Selection](categories.md) — Choose a Preset for your scenario
- [Preset Entry Structure](structure.md) — Entry field reference (developers)
- [Commander Mode](commander.md) — Preset takes over full message assembly (developers)
- [Preset-Mode Binding](mode-binding.md) — Mode binding mechanism (developers)
