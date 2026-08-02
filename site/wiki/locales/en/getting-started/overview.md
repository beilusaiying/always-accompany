# Quick Start

## Step 1: Add an AI Service Source

[Settings → AI Service Sources](beilu:settings/api) → Add:

| Field | What to Enter |
|-------|---------------|
| Name | Any name you like, just to tell sources apart |
| Service URL | API endpoint (e.g. `https://api.openai.com/v1/chat/completions`) |
| API Key | The secret key from your provider |
| Channel | Choose the matching provider (OpenAI / Claude / Gemini, etc.) |
| Model | Pick an available model |

After saving, make sure this source is selected in the model selector on the left panel. See [Configure AI Service Sources](install.md) for details.

## Step 2: Pick a Character and Start Chatting

Click a Character Card in the left panel, type a message in the input box at the bottom, and the AI will respond.

Don't have any characters? Tap the "+" above the character list to create one — just give it a name.

## Step 3: Switch Modes as Needed

Use the four buttons at the top to switch modes:

| Mode | Shortcut | Purpose |
|------|----------|---------|
| Smart Mode | Ctrl+1 | Task board + approvals |
| AIRP | Ctrl+2 | Character conversations (default) |
| IDE | Ctrl+3 | AI-assisted coding + file operations |
| Work Mode | Ctrl+4 | Workflows + scheduled tasks |

See [Mode System](beilu:wiki/modes/overview.md) for details.

## What's Next

- Adjust AI response style → switch Presets, see [Presets & Parameters](first-chat.md)
- Let the AI remember things → [Memory System](beilu:wiki/memory/overview.md) works automatically; you can also manage it manually
- Add world-building lore → write a World Book in [Editor Tab 2](beilu:editor/worldbook)
- Tune parameters → model parameter panel on the left (temperature / top_p, etc.)
- Use Macros → [Macro System](beilu:wiki/macros/overview.md) to insert dynamic content into Presets
