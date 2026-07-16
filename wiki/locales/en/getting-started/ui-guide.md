# Interface Layout

## Three-Column Structure

| Area | Contents |
|------|----------|
| Left Panel | Character info / Preset selector / World Book / model parameters (varies by mode) |
| Center | Message stream |
| Right Panel | Runtime toggles / task board (collapsible) |
| Top | Mode selector (4 main modes) |
| Bottom | Input box |

The left and right panels can be resized by dragging and collapsed to hide. In IDE / Work Mode, the layout switches to an activity bar + sidebar style.

## Mode Switching

The 4 buttons at the top (Ctrl+1–4) switch the main mode. Click "..." to access auxiliary views (Bot Management / Game Companion / Memory Management / ST Adapter).

## Common Actions

| Action | How |
|--------|-----|
| Send a message | Enter |
| New line without sending | Shift + Enter |
| Regenerate | Button below the message |
| Edit a message | Click on the message content |
| Delete a message | Right-click → Delete |
| Start a new conversation | Overflow menu → New Conversation |
| Switch character | Click another Character Card in the left panel |

## Settings Panel

Open with the gear icon. Contains 13 sections:

| Section | Controls & Features |
|---------|---------------------|
| Language | Language switcher dropdown (zh-CN / zh-TW / en-UK / ja-JP) |
| Interface | Dark / light mode toggle, 37 color schemes, 8 enhanced themes, import / export custom themes, font size slider (12–20), message density (3 levels), popup background color picker, popup opacity slider, message load count, context message count, chat background settings (upload image / enter URL / zoom / opacity / blur), display options toggle (character name / system info / Preset button / multi-window follow / clean mode) |
| [AI Service Sources](beilu:wiki/ai-service/api-config.md) | API source list management (create / delete / edit), config name, channel dropdown (OpenAI / Claude / Gemini / DeepSeek / OpenRouter / Ollama / generic compatible, etc.), URL, Key, model name, fetch model list, Extended Thinking toggle + Budget slider, save, chain-of-thought collapse settings (label config) |
| Wiki | This manual (current page) |
| Account | Current user display, switch user, registered user list, admin actions (login / reset password / rename / delete user), change password, security questions (3 Q&A pairs), delete current account |
| [Security Center](beilu:wiki/security/overview.md) | Security summary panel, one-click security check, checklist (dynamic controls: dropdown / toggle / EJS / list), content filtering (blacklist keywords / username filter), iframe security level (3 tiers) |
| Backup | Message load count setting, conversation backup list (one-click restore), file version history (watched folders / backup strategy / retained version count), GitHub integration (link repo / sync / test connection / unlink), file version browser (diff comparison / rollback), Character Card data domain sync |
| Import / Export | Import / export / full management for 6 object types: Character Cards (png / json), World Books (json), Presets (json), Regex (json), Memory Packs (zip / json), Themes (json); import history |
| [Plugin Management](beilu:wiki/plugins/overview.md) | Installed plugin enable / config list, beilu-sysinfo config (time / system / memory injection toggles), AI injection text config (edit by module group) |
| Remote | LAN address list, QR code sharing, external app API Key management (create Key + permission scope config) |
| Backend Monitor | CSP toggle, runtime log (level filter / auto-refresh / copy / clear), error tracking (source filter / console bridge / export), system status (uptime / memory / error count), plugin load status, frontend diagnostics module (15 toggles + level + white-box tracing + full export) |
| Request Preview | Select conversation + generate preview, stats (message count / character count / tokens / model), Messages tab, Parameters tab, Raw JSON tab |
| About | Version number, author info |
