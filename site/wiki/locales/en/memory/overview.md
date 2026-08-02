# Memory System

AI automatically remembers important information from conversations -- character traits, user preferences, past events -- all persisted across conversations.

## What You Need to Do

**Usually nothing.** The memory system runs fully automatically: AI writes, recalls, and archives on its own.

To manage manually: open [Memory Management](beilu:mode/memory) to view, edit, or delete any memory entry.

## Automatic Workflow

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>User sends a message</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>Retrieve persistent memories from the Hot Layer</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>Recall engine scans the warm layer</b><small>Matches relevant entries</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>Assembled into context and sent to AI</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>AI replies with &lt;tableEdit&gt;</b><small>Writes back to Memory Tables</small></div>
</div>

## Three-Layer Memory Architecture

Memory is organized by "temperature" -- the hotter the layer, the closer it is to the AI:

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot (Hot Layer)</span>
Active memory, automatically injected into context every turn <span class="wiki-badge">Auto</span>
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm (Warm Layer)</span>
Recent memory, recalled on demand (pulled in when keywords match) <span class="wiki-badge wiki-badge-blue">Recall engine triggered</span>
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">cold (Cold Layer)</span>
Archived memory, long-term storage, reachable via search <span class="wiki-badge wiki-badge-green">Manual search</span>
</div>
</div>

## Memory Tables

Memory is stored in **structured tables**. In Chat Mode there are 10 tables (#0 through #9), each corresponding to a different type of information (time & space, character traits, user info, etc.). AI performs CRUD operations on the tables via the `<tableEdit>` tag.

See [Memory Tables (#0-#9)](tables.md) for details. You can also view and manage tables in [Memory Management](beilu:mode/memory).

## Memory Lifecycle

<div class="wiki-flow">
<div class="wiki-box wiki-box-green"><b>New information is generated</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>AI writes to Hot Layer tables</b><small>&lt;tableEdit&gt; tag</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>Hot Layer memory is auto-injected into context each turn</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">As time passes</div>
<div class="wiki-box wiki-box-blue"><b>Automatically migrated to the warm layer</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">Further aging</div>
<div class="wiki-box wiki-box-purple"><b>Migrated to the cold layer for archival</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>Recall engine retrieves from warm/cold layers</b><small>When needed</small></div>
</div>

## Memory Management Interface

In [Memory Management](beilu:mode/memory), the top toolbar provides 7 quick-access buttons:

| Button | Name | Function |
|--------|------|----------|
| table | Tables | Open the [Data Table Editor](tables.md) to directly edit #0-#9 table contents |
| diag | P1 Diagnostics | View P1 recall engine runtime status and cache |
| snapshot | Snapshots | Manage [memory snapshots and Git snapshots](archival.md); create/restore |
| retrieval | Retrieval Settings | Adjust P1 auto-trigger, citation count, search rounds, timeout, etc. |
| format | Format Check | Scan memory files, report pass/warning/error counts, with one-click upgrade |
| pseries | P-Series Engine | Edit [P1-P8 Preset](presets.md) prompts, AI sources, models, and parameters |
| skills | Instruction Library | Manage instructions for different modes (trigger rules, body text, etc.) |

### Inline Settings Bar (T040a)

The management panel includes a persistent settings chip bar for quick adjustments:

- P1 auto-trigger toggle -- enable/disable P1 auto-recall each turn
- Citation count number -- control the number of recalled entries injected
- Search rounds number -- maximum rounds for P1 multi-round search
- "More settings" button -- expand the full retrieval settings panel

### Three Main Sections

- **Memory Content** (content) -- Sub-tabs: File Tree / Tables. Browse and edit memory files and table data
- **Retrieval / Diagnostics** (diagretr) -- Sub-tabs: Diagnostics / Retrieval. View P1 runtime status and adjust retrieval parameters
- **Memory Operations** (ops) -- Sub-tabs: Snapshots / Format / Import & Export. Backup, restore, and format maintenance

### Memory File Browser

The file tree displays the five-layer directory structure: hot / warm / cold / code / work:

- Files starting with `_` and `.bak` files are hidden by default; each layer has dedicated icon mappings
- Each file shows its size and relative timestamp
- Click a file to open it in the right-panel JSON editor for direct editing and saving

The **Archive Toolbar** provides batch operations: Archive temporary memories / End today / Hot to Warm / Warm to Cold / Archive completed tasks.

**Code layer tools**: regex search, create folder, import/export zip.

## Dive Deeper

### Memory AI Presets

Behind the scenes, the memory system employs 8 specialized AI Presets working in concert:

- **P1**: Retrieval AI -- NLP tokenization, associative expansion, four-dimensional scoring; recalls memories from warm/cold layers
- **P2**: Table summarization/archival -- generates summaries and archives to the warm layer when temporary memories exceed the threshold
- **P3**: Daily summary -- compiles a summary of the day's events at end-of-day
- **P4**: Hot-to-warm transfer -- moves expired/low-weight memories into the warm layer
- **P5**: Monthly summary/archival -- compiles monthly summaries for warm-layer months
- **P6**: Format check/repair -- maintains table and memory file formatting
- **P7**: Context Compression AI -- generates summaries when context gets too long
- **P8**: Web search -- invoked when external information is needed

See [Memory AI Presets (P1-P8)](presets.md) for details.

### Relationship with World Book

The memory system manages **dynamically generated information** (events from conversations, things AI has learned). World Book manages **pre-defined background knowledge** (world settings, character profiles, rules). Both are delivered to context through the Injection system (INJ), but their sources and management methods differ.

## Navigation

- [Memory Tables (#0-#9)](tables.md) -- Table structure and purpose of each table
- [Hot Layer Memory](hot-layer.md) -- Hot layer files and auto-injection mechanism
- [Memory AI Presets (P1-P8)](presets.md) -- Division of labor and processing pipeline for each Preset
- [Context Compression](compression.md) -- P7 compression mechanism
- [Memory Archival & Retrieval](archival.md) -- Warm/cold layer migration and the recall engine
- [World Book Overview](worldbook-overview.md) -- Pre-defined background knowledge system ([World Book Editor](beilu:editor/worldbook))
- [Injection System Overview](inj-overview.md) -- How information enters the context
