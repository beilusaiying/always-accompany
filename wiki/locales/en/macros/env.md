# env Custom Variable Macros

Plugins inject custom key-value pairs via `extension.macro_env`, and these keys automatically become available Macros.

## How It Works

```
Plugin sets extension.macro_env.my_key = "my_value"
  -> my_key appears in the Macro environment
  -> Writing {{my_key}} in a Preset replaces it with "my_value"
```

This is a **fully dynamic** mechanism — plugins can update values in `macro_env` at any time, and the new values will be used the next time Macros are replaced.

## Existing env Macros

The following env Macros are currently injected by official always-accompany plugins:

| Macro | Injection Source | Description |
|-------|-----------------|-------------|
| `{{workspace_root}}` | beilu-files | Root directory path of the current workspace |
| `{{workspace_tree}}` | beilu-files | Directory tree structure of the current workspace |
| `{{active_preset_name}}` | Preset system (core) | Name of the currently active Preset |
| `{{active_preset_description}}` | Preset system (core) | Description of the currently active Preset (the description field) |
| `{{work_sub_modes_list}}` | beilu-memory | Full list of Work Mode sub-modes (with descriptions); empty outside Work Mode. Dynamic content — only use in the tail entry `INJ-work-submodes-data` (see "Data Injection Entries and Data Macros" page) |
| `{{code_sub_modes_list}}` | beilu-memory | Full list of Code Mode sub-modes (with descriptions); empty outside Code Mode. Dynamic content — only use in the tail entry `INJ-code-submodes-data` |
| `{{current_mode}}` | beilu-memory | The currently active mode (chat/code/work, etc.) |
| `{{active_project}}` | beilu-memory | Name of the currently active project |
| `{{browser_status}}` | beilu-browser | Browser connection status (connected / disconnected). Dynamic content — only use in the tail entry `INJ-browser-status-data` (split from INJ-browser head on 0722) |
| `{{browser_port}}` | beilu-browser | Chrome CDP debug port number (travels with the status line in the tail entry) |

> **Iron Rule for Dynamic Macro Placement**: Macros that change every turn or frequently (state, lists, data types) are forbidden in head (`depth >= 1`) entry templates — a single character change in the head invalidates the entire prompt cache prefix. Dynamic Macros must always be placed in tail `*-data` entries. See "Data Injection Entries and Data Macros" page for details.

### {{workspace_root}}

Injected by the beilu-files plugin. The value is the root directory path of the current file workspace. In Code Mode, the AI can use this Macro to know where the project is located.

### {{workspace_tree}}

Injected by the beilu-files plugin. The value is a text representation of the current workspace's directory tree. It lets the AI understand the project's file structure without listing files one by one.

### {{active_preset_name}} and {{active_preset_description}}

Mounted by the Preset system while assembling the prompt (same source as the Preset engine actually used for this turn). Replaced with the name and description of the currently active Preset.

Their main use is the **identity self-check** in the Preset thinking skeleton (beilu_think):

```
Current task identity={{active_preset_name}}
!!!Is what I am about to do within my identity scope!!!:{{active_preset_name}}—{{active_preset_description}}
```

Before each reply, the AI verifies the current work against the real Preset identity and its description, instead of filling in a blank by feel. The Preset description can be edited in the Preset management UI, and the Macro value follows immediately.

### {{work_sub_modes_list}} and {{code_sub_modes_list}}

Exported by beilu-memory. Replaced with the real-time list of all sub-modes of the corresponding mode, one per line in the format `- id: label — description`. Each Macro only has content while its own mode is active (the work Macro in Work Mode, the code Macro in Code Mode); otherwise it is replaced with an empty string, so the two Macros can be written side by side without interfering:

```
Does the current work match the current identity:{{work_sub_modes_list}}{{code_sub_modes_list}}
```

The list comes from live sub-mode configuration data — reference the Macro in Presets instead of hand-writing sub-mode lists (hand-written lists drift as the configuration changes).

## How Plugins Inject Custom Macros

For plugin developers, the way to inject custom Macros is to set `extension.macro_env` in the plugin:

```
extension.macro_env = {
    my_custom_key: "value will be filled in during Macro replacement",
    another_key: dynamicValue
};
```

After setting this, `{{my_custom_key}}` and `{{another_key}}` can be used in Presets and Character Cards.

### Key Points

- **Key name equals Macro name**: Keys in `macro_env` directly correspond to `{{key_name}}` Macros
- **Values can be updated dynamically**: Plugins can update `macro_env` values at runtime, and the next Macro replacement will automatically use the new values
- **Multi-plugin merging**: `macro_env` entries from multiple plugins are merged into the same Macro environment
- **Backend replacement**: env Macros are replaced during the backend Macro engine (evaluateMacros) stage

## Processing Pipeline

```
Each plugin sets extension.macro_env during initialization or at runtime
  -> User sends a message
  -> Backend assembles the prompt
  -> TweakPrompt Round1: buildMacroEnvFromPromptStruct
     Merges macro_env from all plugins into the Macro environment
  -> Round2: PresetEngine.buildAllEntries -> evaluateMacros
     When encountering {{key}}, looks up and replaces from the Macro environment
  -> The replaced prompt is sent to the AI
```

## Comparison with Other Macros

| Dimension | env Macros | Built-in Macros (e.g. {{user}}) | Variable Macros (e.g. {{getvar::x}}) |
|-----------|-----------|-------------------------------|-------------------------------------|
| Definition method | Injected by plugins via macro_env | Hardcoded in the Macro engine | Set by users via setvar |
| Value source | Computed by plugins at runtime | System state (username, etc.) | macroMemory storage |
| Extensibility | Arbitrarily extensible | Fixed set | Arbitrary key names |
| Persistence | Valid within the plugin lifecycle | Always valid | Persisted to Preset |
| Use case | Exposing data from plugins to the AI | Basic information placeholders | Conversation state tracking |

## Notes

- env Macros only take effect during backend replacement; the frontend does not process them
- If multiple plugins inject a Macro with the same name, the later injection overrides the earlier one
- env Macro values can be strings or values that will be converted to strings
- After a plugin is uninstalled or disabled, its injected env Macros are no longer available, and the corresponding `{{macro_name}}` tokens remain as-is without replacement
