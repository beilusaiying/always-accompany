# Mode System

Press Ctrl+1–4 (or Alt+1–4) to switch modes. Each mode is a self-contained work environment with its own layout, panels, and AI behavior.

## Four Main Modes

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Smart Mode <span class="wiki-badge">Ctrl+1 / Alt+1</span></div>
<div class="wiki-card-desc">Three columns (left/right collapsible)<br>Persona management, World Book, task board</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Chat/AIRP <span class="wiki-badge">Ctrl+2 / Alt+2</span></div>
<div class="wiki-card-desc">Three columns<br>Roleplay conversation, Preset management</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Code/IDE <span class="wiki-badge">Ctrl+3 / Alt+3</span></div>
<div class="wiki-card-desc">IDE-style layout (activity bar + sidebar + main area)<br>Code editing, file browsing, coding assistance</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Work <span class="wiki-badge">Ctrl+4 / Alt+4</span></div>
<div class="wiki-card-desc">IDE-style layout<br>Task management, approvals, delegation, scheduled tasks</div>
</div>
</div>

When you switch modes, the system automatically loads the Preset, API source, and model parameters bound to that mode, changing the AI's behavior accordingly.

## Four Auxiliary Views

Accessible from the auxiliary menu, these provide management and configuration interfaces:

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Bot Management <span class="wiki-badge-blue">Auxiliary menu</span></div>
<div class="wiki-card-desc">Multi-platform Bot configuration and permission management</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Companion <span class="wiki-badge-blue">Auxiliary menu</span></div>
<div class="wiki-card-desc">Desktop pet, Live2D, AI autonomous behavior</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Memory <span class="wiki-badge-blue">Auxiliary menu</span></div>
<div class="wiki-card-desc">Memory Tables viewing and editing, AI Preset execution</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Helper (ST Adapter) <span class="wiki-badge-blue">Auxiliary menu</span></div>
<div class="wiki-card-desc">Regex scripts, variable management, ST compatibility tools</div>
</div>
</div>

## Submodes

[Code](beilu:mode/files) and [Work](beilu:mode/work) modes each have 11 submodes for more granular workflow stages. Each submode can independently bind its own Preset, API source, model, and Sampling Parameters. See [Submodes & Switching](beilu:wiki/modes/submodes.md) for details.

## Deep Dive: Two-Layer Mode Architecture

always-accompany's mode system consists of two layers:

| Layer | Description | Possible Values |
|-------|-------------|-----------------|
| Backend mode (B channel) | Authoritative mode value that determines AI behavior and Preset loading | `chat` / `smart` / `code` / `work` / `bot` |
| Frontend Tab (UI view) | Display layer that determines layout and panels | `smart` / `chat` / `files` / `work` / `memory` / `bot` / `companion` / `helper` / `settings` / `editor` |

The backend mode is the authoritative source; the frontend Tab is the view layer. One backend mode may correspond to multiple frontend Tabs (for example, the `chat` mode serves the Chat, Bot, Helper, and other views), but each Tab maps to at most one backend mode.

### Mode-to-Tab Mapping

**Forward mapping** (backend mode → frontend Tab):

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<b>Backend Mode (B Channel)</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-amber"><b>chat</b><small>→ chat</small></div>
<div class="wiki-box wiki-box-amber"><b>smart</b><small>→ smart</small></div>
<div class="wiki-box wiki-box-amber"><b>code</b><small>→ files</small></div>
<div class="wiki-box wiki-box-amber"><b>work</b><small>→ work</small></div>
</div>
</div>
</div>

**Reverse mapping** (frontend Tab → backend mode):

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<b>Main Mode Tabs (switch backend mode)</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-amber"><b>chat</b><small>→ chat Chat Mode</small></div>
<div class="wiki-box wiki-box-amber"><b>airp</b><small>→ chat AIRP Roleplay</small></div>
<div class="wiki-box wiki-box-amber"><b>smart</b><small>→ smart Smart Mode</small></div>
<div class="wiki-box wiki-box-amber"><b>bot</b><small>→ chat Bot Management</small></div>
<div class="wiki-box wiki-box-amber"><b>helper</b><small>→ chat ST Adapter</small></div>
<div class="wiki-box wiki-box-amber"><b>files</b><small>→ code Code/IDE</small></div>
<div class="wiki-box wiki-box-amber"><b>work</b><small>→ work Work Mode</small></div>
</div>
</div>
<div class="wiki-layer wiki-layer-blue">
<b>View-Only Tabs (do not switch backend mode)</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-blue"><b>memory</b><small>view only</small></div>
<div class="wiki-box wiki-box-blue"><b>companion</b><small>view only</small></div>
<div class="wiki-box wiki-box-blue"><b>settings</b><small>view only</small></div>
<div class="wiki-box wiki-box-blue"><b>editor</b><small>view only</small></div>
</div>
</div>
</div>

### Mode Switching Flow

When the user triggers a mode switch, the system executes the following flow:

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>1. User Action</b><small>Click top selector / press shortcut key / click auxiliary menu</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. switchTab(tabName)</b><small>Frontend switches the UI view</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>3. switchModeTo(targetMode)</b><small>If the Tab maps to a backend mode, trigger backend mode switch</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>4. Backend switchMode</b><small>Persists the mode value and broadcasts to all connections</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>5. Frontend Update</b><small>After receiving the broadcast, updates UI and restores the corresponding chatId</small></div>
</div>

## Quick Navigation

- [Chat Mode (Chat/AIRP)](beilu:wiki/modes/chat.md) - Roleplay and everyday conversation
- [Code Mode (Code/IDE)](beilu:wiki/modes/ide.md) - AI-assisted coding
- [Work Mode (Work)](beilu:wiki/modes/work.md) - Task management and workflows
- [Bot Mode](beilu:wiki/modes/bot.md) - Multi-platform Bot management
- [Game Companion](beilu:wiki/modes/game.md) - Desktop pet and Live2D
- [Submodes & Switching](beilu:wiki/modes/submodes.md) - Submode details
