# Preset-Mode Binding

always-accompany's mode system ([Chat Mode](beilu:mode/chat) / Code / [Work Mode](beilu:mode/work) / [Bot Management](beilu:mode/bot)) is deeply integrated with the Preset engine. Each mode can bind an independent Preset, and switching modes automatically switches the Preset so the AI receives appropriate instructions for each work scenario.

## Binding Data Structure

### mode_preset_bindings

Mode binding relationships are stored in the memory system's global configuration (`_config.json`'s `mode_preset_bindings` field):

```
mode_preset_bindings: {
  chat: "PresetNameA",
  code: "PresetNameB",
  work: "PresetNameC",
  bot:  "PresetNameD"
}
```

Each mode binds to exactly one Preset name. When you select a Preset while in a given mode, the binding is automatically updated.

### active_preset_map

In addition to mode-level bindings, each conversation window can independently bind a Preset. `active_preset_map` uses conversation IDs (or mode+character composite keys) as indexes, recording the Preset used by each conversation:

```
active_preset_map: {
  "abc1234": "PresetNameX",           // Preset used by a specific conversation
  "chat:characterName": "PresetNameY", // Preset for a character in Chat Mode
  "code:characterName": "PresetNameZ"  // Preset for a character in Code Mode
}
```

## Preset Selection Priority

When the system needs to determine which Preset to use for a conversation, it resolves in the following priority:

```
Conversation-level active_preset_map[chatId]
    ↓ not found → mode+character composite key active_preset_map[mode:charName]
    ↓ not found → mode binding mode_preset_bindings[mode]
    ↓ not found → global default active_preset
```

## Behavior on Mode Switch

After the user switches modes, the Preset engine's behavior:

1. Frontend notifies the backend to switch modes (switchMode)
2. Backend reads the target mode's active conversation (using pointer)
3. Resolves that conversation's Preset from active_preset_map
4. If the conversation has no independent Preset, falls back to mode_preset_bindings
5. Loads the corresponding Preset into the engine; subsequent conversations use the new Preset

## Submode Binding

Code and Work modes each have 11 submodes. Each submode can independently bind:

- Preset
- AI Service Source
- Model name
- Sampling Parameters (temperature, etc.)

Submode parameters override engine parameters during TweakPrompt Round 2. Override chain:

```
Submode parameters > runtime model_overrides_by_char > global runtime_params > Preset eng.modelParams
```

Submode information is passed to the Preset engine via beilu-memory's extension (`sub_mode_*` fields), and the Preset engine merges parameters accordingly.

## P1 Preset Switch Signal

The memory system's P1 pipeline can trigger Preset switches at runtime. When the `preset_switch_to` field appears in the extension, the Preset engine will:

1. Detect the signal during TweakPrompt Round 1
2. Switch to the specified Preset
3. Persist the change to disk (saveConfigToDisk)
4. Resync the regex Preset (`_resyncPresetRegex`)
5. Use the new Preset for subsequent turns

This allows the AI to automatically switch Presets based on conversation content (e.g., from a chat Preset to a coding Preset).

## Bot Mode Preset Resolution

Bot Mode has special Preset resolution logic:

- Bot conversations resolve their mode through the `resolveBotModeFromRequest` single-source function
- Bot Preset mapping keys use the `bot:characterName` format
- Bot Mode reuses the chat backend mode, but Preset bindings are independent

## Data Persistence

| Data | Storage Location | Description |
|------|-----------------|-------------|
| mode_preset_bindings | Memory system _config.json | Mode-level bindings |
| active_preset_map | Preset config.json | Conversation / character-level bindings |
| active_preset | Preset config.json | Global default Preset |

Preset config.json is isolated per user (`data/users/<user>/presets/config.json`), so each user has their own independent Preset configuration.

## Cleanup Mechanism

When a conversation is deleted, the system automatically cleans up the corresponding entry in active_preset_map for that conversation ID, preventing orphaned entries from accumulating in the configuration file.

## Navigation

- [Preset System Overview](overview.md) — Preset fundamentals
- [Mode System Overview](../modes/overview.md) — Mode architecture
- [Submodes & Switching](../modes/submodes.md) — Submode details
