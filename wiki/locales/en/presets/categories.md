# Preset Categories & Selection

## Switching and Filtering Presets

### By Use Case

| What You Want to Do | Recommended Category | Reason |
|---------------------|----------------------|--------|
| Roleplay conversation | clone | Includes character behavior guidance and conversation style control |
| Everyday chat | clone or General | Lightweight instructions, natural conversation |
| Write code | code | Includes code standards, output format, and tool usage instructions |
| Task management / documents | work | Includes task decomposition, formatting requirements, and approval workflows |
| Custom scenario | Create your own Preset | Fully tailored to your needs |

### Per-Character / Per-Conversation Settings

Each character and each conversation window can independently bind a Preset. The system uses **active_preset_map** to record which Preset each conversation uses, without interference:

- Chatting with Character A uses Preset X
- Chatting with Character B uses Preset Y
- Switching conversation windows automatically restores the Preset

## Managing Presets

### Viewing Installed Presets

In the Preset management panel, you can see all installed Presets grouped by bucket. Each Preset shows its name, description, and current status.

### Importing Presets

Supports importing SillyTavern-format Preset JSON files. During import, the system will:

1. Parse the Preset JSON to extract entries and parameters
2. Register it in registry.json
3. If a bucket field is present, assign it to the corresponding category
4. If model_params are included, save the model parameters

### Exporting Presets

You can export the current Preset as a SillyTavern-compatible JSON file for sharing or backup. You can also batch-operate through the [Import / Export](beilu:settings/import-export) panel. Exports include all entries, sort order, parameters, and category information.

### Deleting Presets

Deleting a built-in Preset actually marks it as "deleted" (recorded in config.json's deleted_builtins), and it can be restored at any time. User-created Presets must be re-imported after deletion.

## Category Logic

always-accompany uses **buckets** to categorize and manage Presets. Each Preset is tagged with a bucket when registered, and the frontend groups them by bucket.

### Built-in Categories

| Bucket | Description | Preset Count | Applicable Mode |
|--------|-------------|--------------|-----------------|
| code | Coding assistance Presets | 11+ | Code / IDE Mode |
| work | Workflow Presets | 12+ | Work Mode |
| clone | Roleplay / clone Presets | 5+ | Chat / AIRP Mode |
| _(uncategorized)_ | General Presets | As needed | All modes |

### Category Source

A Preset's bucket information is recorded in **registry.json** (the Preset registry), which is the single authoritative source for grouping. If a Preset JSON file includes a bucket field during import, it is automatically registered to the corresponding category.

Presets without a bucket field will be matched by the frontend based on keywords in the Preset name as a fallback, placing them in the most fitting group.

## Preset Selection Priority

When the system determines which Preset to use for a conversation, it follows this priority:

1. **Conversation-level**: the "currently in use" Preset recorded in active_preset_map keyed by chatId (including precise chatId:mode keys)
2. **Global default**: active_preset (the globally "currently in use" Preset)

## Navigation

- [Preset System Overview](overview.md) — Preset fundamentals
- [Preset Entry Structure](structure.md) — Entry field reference
