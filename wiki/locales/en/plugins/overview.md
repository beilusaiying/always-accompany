# Plugins

View and configure all plugins in the [Plugin Management](beilu:settings/plugins) panel. always-accompany has 18 built-in plugins, grouped by function as follows.

## Plugin List

<div class="wiki-group">
<div class="wiki-group-title">Core Plugins <span class="wiki-badge-red">Core</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-memory</div>
<div class="wiki-card-desc">Memory system (tables / Hot Layer / archival / recall)</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-preset</div>
<div class="wiki-card-desc">Preset engine (prompt assembly)</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-worldbook</div>
<div class="wiki-card-desc">World Book (keyword-triggered background Injection)</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">Tool Plugins <span class="wiki-badge-green">Tool</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-files</div>
<div class="wiki-card-desc">Sandboxed file read/write/delete/execute</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-web</div>
<div class="wiki-card-desc">Web search and page browsing</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-ppt</div>
<div class="wiki-card-desc">PPT generation</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">Perception Plugins <span class="wiki-badge-blue">Perception</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">beilu-eye</div>
<div class="wiki-card-desc">Desktop screenshot perception + Electron desktop pet</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">Enhancement Plugins <span class="wiki-badge">Enhancement</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-regex</div>
<div class="wiki-card-desc">Regex script engine (AI reply post-processing)</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-mvu</div>
<div class="wiki-card-desc">Variable system (local/global variable read/write)</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-ejs</div>
<div class="wiki-card-desc">EJS template rendering</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-toggle</div>
<div class="wiki-card-desc">Dynamic toggle for entries (Preset / World Book entries)</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-vectordb</div>
<div class="wiki-card-desc">Vector database (semantic retrieval)</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-graphrag</div>
<div class="wiki-card-desc">Knowledge graph</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">Foundation & Development <span class="wiki-badge-blue">Foundation/Dev</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-sysinfo</div>
<div class="wiki-card-desc">System monitoring (CPU / memory / network)</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-logger</div>
<div class="wiki-card-desc">Logging</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-plugin-host</div>
<div class="wiki-card-desc">User plugin host</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-tutorial</div>
<div class="wiki-card-desc">In-app tutorial / wiki (this help page is rendered by it)</div>
</div>
</div>
</div>

## Plugin Configuration

Each plugin has its own configuration panel (click the corresponding plugin in [Plugin Management](beilu:settings/plugins) to open it). Security-sensitive configuration writes (such as beilu-files' allowExec and beilu-ejs' sandboxOptOut) require instance owner permission. See [Security Center](../security/overview.md) ([Go to Security Center](beilu:settings/security)) for details.

## User Plugins

Through beilu-plugin-host, you can write and load custom plugins. User plugins have the same interface capabilities as built-in plugins. See [Plugin Development](../developer/plugin-dev.md) for details.

## Dive Deeper: Plugin Interfaces

Each plugin interacts with the core system through standard interfaces:

### Data Interfaces

| Interface | Direction | Description |
|-----------|-----------|-------------|
| GetData | Core -> Plugin | Read plugin configuration and state |
| SetData | Core -> Plugin | Write plugin configuration or trigger an action |

### Message Pipeline Interfaces

| Interface | Invocation Timing | Description |
|-----------|-------------------|-------------|
| GetPrompt | Before message is sent | Returns content the plugin wants to inject into the prompt |
| TweakPrompt | After GetPrompt | Modifies/adjusts the assembled prompt structure (three-round execution) |
| ReplyHandler | After AI replies | Parses tags/instructions in the AI reply and executes them |
| GetReply | During generation call | Intercepts or modifies the AI call request |

### Plugin Invocation Order

During a complete message send/receive cycle, plugins participate in the following order:

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>User sends a message</b><small>Triggers the message pipeline</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>1. GetPrompt</b><small>Collects prompt fragments from all plugins in parallel</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. TweakPrompt x 3 rounds</b><small>Round 1 (dl=2): collect & clear | Round 2 (dl=1): rebuild message sequence | Round 3 (dl=0): snapshot</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>3. StructCall</b><small>Calls AI API (executed by provider/generator)</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red wiki-box-full"><b>4. ReplyHandler</b><small>Parses operation tags in AI reply</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>Store + Broadcast</b><small>Persists message and notifies frontend</small></div>
</div>

### Plugin Loading

**Default plugins**: On startup, always-accompany automatically loads plugins listed in `defaultParts.plugins`. Core plugins (memory / preset / worldbook, etc.) always participate in every conversation.

**Conversation-level plugins**: When creating a conversation, the system merges default plugins into the conversation's timeSlice. Plugins added to the default list later are also automatically included.

## Quick Navigation

- [File Operations (beilu-files)](files.md) -- AI file read/write
- [Screen Perception (beilu-eye)](eye.md) -- Desktop screenshots and desktop pet
- [Web Search (beilu-web)](web.md) -- Search and page browsing
- [Regex Enhancement (beilu-regex)](regex.md) -- AI reply post-processing
- [Variable System (beilu-mvu)](mvu.md) -- Variable read/write
- [Script Engine](scripts.md) -- EJS templates and scripts
- [Plugin Development](../developer/plugin-dev.md) -- Writing custom plugins
