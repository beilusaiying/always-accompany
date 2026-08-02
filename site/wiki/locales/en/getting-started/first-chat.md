# Presets & Parameters

Presets control how the AI behaves — what persona it adopts, what instructions it follows, and what output format it uses.

## Switching Presets

Use the Preset selector on the left panel and pick one from the dropdown. Different Presets suit different scenarios:

| Preset Type | Purpose |
|-------------|---------|
| Chat | Roleplay, casual conversation |
| Code | Code generation, review, debugging |
| Work | Task management, document generation |

Changes take effect immediately — the next message you send will use the new Preset. See [Preset System](beilu:wiki/presets/overview.md) for details.

## Tuning Model Parameters

Expand the "Sampling Parameters" section on the left panel. It contains the following controls:

| Parameter | Control Type | Range | Recommendation |
|-----------|-------------|-------|----------------|
| Temperature | Slider | 0 ~ 2 | Chat 0.7–1.0, Code 0.3–0.5 |
| Top P | Slider | 0 ~ 1 | Usually 0.9–1.0 |
| Top K | Numeric input | 0 ~ 500 | Set based on model support |
| Min P | Slider | 0 ~ 1 | Fine-tune as needed |
| Freq Penalty | Numeric input | -2 ~ 2 | Reduce word repetition |
| Pres Penalty | Numeric input | -2 ~ 2 | Encourage topic diversity |
| Max Context | Numeric input | — | Set based on model capacity; larger = longer memory |
| Max Tokens | Numeric input | — | Set as needed |
| Streaming | Toggle | — | Recommended on |
| Generic Prefill | Toggle | — | Enable as needed |
| Tail Prefill | Dropdown | 4 options | Choose by scenario |
| Post-processing | Dropdown | 4 options | Choose by scenario |

Click "Save" after adjusting. See [Model Parameters](beilu:wiki/ai-service/model-params.md) for details.

## Character Card Editing

Click the edit button on a Character Card to open the [Editor](beilu:editor/persona-edit), which has 5 tabs:

- **Tab 1 Preset Editor**: Category filter + Preset CRUD + search; split-pane layout (left: sortable entry list with drag-and-drop, right: entry detail editor); 9 Marker insertion points
- **Tab 2 [World Book](beilu:wiki/memory/worldbook-overview.md)**: World Book CRUD; split-pane layout (search + entry list / entry editor: title, enable toggle, activation mode, position, depth, keywords, secondary keywords, regex match, dynamic toggle, sort order, character binding, content)
- **Tab 3 User Persona**: Persona card list (avatar + name + description editor + save / activate / delete)
- **Tab 4 [INJ Injection](beilu:wiki/memory/inj-overview.md)**: Stats row + search; split-pane layout (entry list / entry editor: name, enable, character, depth, sort order, injection mode, platform, content); add new / restore defaults
- **Tab 5 [Regex](beilu:wiki/presets/regex.md)**: Three scope levels (global / character / Preset); regex editor (pattern / flags / replace, etc.); live test panel; ReDoS guard

The more specific the character description, the more accurately the AI will play the role.

## User Persona

Set your own identity (name, personality, background) and the AI will adjust its interactions accordingly. Manage this in Editor Tab 3 or in Settings.
