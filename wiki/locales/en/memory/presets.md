# Memory AI Presets (P1-P8)

Behind the scenes, the memory system runs multiple specialized AI Presets, each responsible for a different phase of the memory lifecycle. These Presets are not the user-facing character AI, but system-level background workers.

## Preset Overview

| Preset | Name | Role | Trigger Timing |
|--------|------|------|----------------|
| **P1** | Retrieval AI | NLP tokenization + associative expansion + four-dimensional scoring; recalls relevant memories from warm/cold layers | Before each conversation turn |
| **P2** | Table Summary/Archival AI | Generates summaries and archives to the warm layer when temporary memories exceed the threshold | Temporary memory exceeds threshold |
| **P3** | Daily Summary AI | Compiles a summary of the day's events at end-of-day | End of day |
| **P4** | Hot-to-Warm Transfer AI | Moves expired/low-weight memories from the Hot Layer to the warm layer | During migration check |
| **P5** | Monthly Summary/Archival AI | Compiles monthly summaries for warm-layer months that have reached the archival period | During monthly archival |
| **P6** | Format Check/Repair AI | Checks and fixes formatting issues in tables and memory files | During format check / one-click upgrade |
| **P7** | Compression AI | Generates summaries when context is too long | When context exceeds limit |
| **P8** | Web Search AI | Invokes external search to obtain information | When AI determines external information is needed |

## P1: Retrieval AI

P1 is the memory recall engine (P1 self-driven pipeline), running automatically before each conversation turn.

**Processing pipeline**:

```
User message arrives
    ↓
NLP tokenization: split user message into keywords
    ↓
Associative expansion: semantically expand keywords, generating an extended word set
    ↓
Multi-word co-occurrence matching: search warm/cold layers for memory entries containing the expanded words
    ↓
Four-dimensional scoring: score each candidate entry across four dimensions
    ↓
Sort and filter: select the highest-scoring entries
    ↓
Inject into context: assemble recalled entries into the current turn's context
```

**Four-dimensional scoring**:

| Dimension | Meaning | Weight Tendency |
|-----------|---------|-----------------|
| **semantic** | Semantic relevance | How closely the content matches the current topic semantically |
| **lexical** | Lexical match | Degree of direct keyword matching |
| **recency** | Temporal recency | More recent memories score higher |
| **importance** | Importance | Memories marked as important score higher |

Scores from the four dimensions are weighted and summed, then sorted; the top-N entries are injected into context.

## P2: Summary & Archival

P2 is responsible for distilling temporary memories into structured memory and archiving them to the warm layer.

**Processing pipeline**:

```
Temporary memory exceeds threshold
    ↓
P2 reads temporary memory content
    ↓
Extracts key information: events, emotions, decisions, new insights
    ↓
Summarizes into structured entries
    ↓
Writes to the corresponding Memory Table (via the <tableEdit> mechanism)
    ↓
Archives to the warm layer (triggers migration check)
```

## P3-P6: Memory Lifecycle Maintenance

P3 through P6 each handle a specific phase of memory "metabolism," running automatically in the background at the appropriate time:

| Preset | Role | Description |
|--------|------|-------------|
| **P3 Daily Summary AI** | End-of-day event compilation | Compiles the day's events into a daily summary at end-of-day (corresponds to #6 Daily Summary table) |
| **P4 Hot-to-Warm Transfer AI** | Hot Layer cooling | Moves expired or low-weight memory entries from the Hot Layer to the warm layer, controlling Hot Layer capacity |
| **P5 Monthly Summary/Archival AI** | Monthly archival | Compiles monthly summaries for warm-layer months that have reached the archival period; physical migration is executed automatically by the system |
| **P6 Format Check/Repair AI** | Format maintenance | Checks and fixes formatting issues in tables and memory files, used alongside the toolbar's "Format Check / One-click Upgrade" |

These Presets, together with P1 (recall), P2 (archival), P7 (compression), and P8 (web search), form the complete memory pipeline. Users typically do not need to intervene manually.

## P7: Compression AI

P7 triggers when context approaches the limit, generating conversation summaries to free up space.

**Processing pipeline**:

```
Context token count approaches the model limit
    ↓
System triggers P7
    ↓
P7 reads earlier conversation turns
    ↓
Generates a compressed summary
    ↓
Summary is stored in context_summary.json
    ↓
Original conversation turns are removed from context
    ↓
In subsequent conversations, the summary replaces the original content in context
```

See [Context Compression](compression.md) for details.

## P8: Web Search

P8 triggers when the AI determines external information is needed.

**Processing pipeline**:

```
AI determines the current question requires external information
    ↓
System invokes P8
    ↓
P8 constructs a search query
    ↓
Calls the search API and obtains results
    ↓
Injects search results into the current context
    ↓
AI continues replying based on search results
```

## Collaboration Between Presets

In a typical conversation turn, Presets collaborate in this order:

```
User sends a message
    ↓
P1 recalls relevant memories → injects into context
    ↓
AI replies (may trigger P8 web search)
    ↓
<tableEdit> in AI's reply writes to the Hot Layer
    ↓
When threshold is reached, P2 performs summary and archival
    ↓
When context is too long, P7 performs compression
```

## P-Series Engine Editing Panel

In [Memory Management](beilu:mode/memory), click the **pseries** button on the toolbar to open the P-Series engine editing panel.

### Layout

- **Left-side list**: Displays all Presets P1 through P8; click to switch
- **Right-side details**: Shows and allows editing of the selected Preset's full configuration

### Editable Fields

| Field | Description |
|-------|-------------|
| Enabled toggle | Controls whether this Preset is active |
| Description | Explanatory text for the Preset's function |
| AI call parameters | AI source, model, post-processing, prefill, temperature, etc. |
| Prompt groups | Edit different prompt sets by view mode (chat / code / work) |

### Prompt Editing

After switching view modes, the right side displays the prompt list for that mode. Supports full CRUD: create new prompt entries, edit content, adjust order, and delete entries.

## Memory AI Preset Interaction Panel

In the Retrieval / Diagnostics section of [Memory Management](beilu:mode/memory), or through the Preset switcher, access the interaction panel.

### Preset Switcher

Shows available Presets based on the current mode:

- **Chat Mode**: Shows P2-P6
- **Code/Work Mode**: Shows P2-P7

Click a Preset name to switch to its interaction interface.

### AI Conversation Interaction

- **Run Preset**: Click the run button; the system invokes the selected Preset, and results are displayed as bubbles
- **User input**: Append messages in the input box and send to have a multi-turn conversation with the Preset AI
- **Async execution**: Long-running Presets can run in the background; click "View" to retrieve results when finished
- **Clear**: Reset the current Preset's conversation history

### Prompt Preview

The interaction panel provides three preview tabs:

| Tab | Content |
|-----|---------|
| Message list | Displays the final message structure sent to AI, organized by section |
| Raw JSON | View the complete raw request data |
| Preset preview | Preview the Preset's own configuration content |

### File Tree and Import/Export

- **File tree view**: Browse Preset-related files in a tree structure
- **Import/Export**: Supports Preset import and export in zip and json formats

## Instruction Library

In [Memory Management](beilu:mode/memory), click the **skills** button on the toolbar to open the Instruction Library manager.

### Structure

Instructions are categorized by mode (e.g., IDE mode, Work Mode). The left-side list shows all instructions for the current mode; the right side displays details of the selected instruction.

### Creating and Editing

Clicking the create or edit button opens a floating dialog with the following fields:

- **Name**: The instruction's identifier
- **Purpose**: Functional description
- **Mode**: Applicable work mode
- **Triggers**: Trigger conditions (when to activate this instruction)
- **Body**: The instruction's full content

## Diagnostics Panel

In [Memory Management](beilu:mode/memory), click the **diag** button on the toolbar, or switch to the "Diagnostics" sub-tab in the Retrieval / Diagnostics section.

The panel displays the following information:

- **Plugin enabled status**: Whether the memory plugin is enabled
- **auto_trigger**: Whether P1 auto-trigger is on
- **P1 status**: Current P1 engine runtime status
- **Cache info**: Cache character count and cache time
- **Output queue**: Pending output entries
- **Enabled Presets list**: List of currently enabled Presets
- **Cache content**: Expandable to view the full cached data

## Development Notes

- Each Preset uses an independent system prompt that defines its behavior and output format
- Trigger conditions and thresholds for Presets are configurable
- P1's recall quality directly affects the AI's "memory" performance and is the key area for performance tuning
- P2-P6 each handle a different phase of the memory lifecycle (archival, daily/monthly summaries, migration, format repair), working with P1 recall, P7 compression, and P8 web search to form the complete memory pipeline
