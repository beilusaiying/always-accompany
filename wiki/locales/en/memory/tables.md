# Memory Tables (#0-#9)

Memory Tables are the core storage structure of the always-accompany memory system. AI performs CRUD (Create, Read, Update, Delete) operations on tables via the `<tableEdit>` tag, with each table corresponding to a type of information. Different work modes ([Chat Mode](beilu:mode/chat) / code / [Work Mode](beilu:mode/work)) use different table sets.

## Chat Mode Tables

Chat Mode uses 10 tables, #0 through #9:

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card"><div class="wiki-card-title">#0 Time & Space</div><div class="wiki-card-desc">Current time, location, scene -- AI perceives "where am I now, what time is it"</div></div>
<div class="wiki-card"><div class="wiki-card-title">#1 Character Traits</div><div class="wiki-card-desc">Personality, appearance, habits -- AI maintains character consistency</div></div>
<div class="wiki-card"><div class="wiki-card-title">#2 Social</div><div class="wiki-card-desc">Relationships, affinity levels, interaction history -- AI understands relationships between characters</div></div>
<div class="wiki-card"><div class="wiki-card-title">#3 Tasks</div><div class="wiki-card-desc">Current tasks in progress, goals -- AI tracks task progress</div></div>
<div class="wiki-card"><div class="wiki-card-title">#4 Temporary Memory</div><div class="wiki-card-desc">Short-term events, temporary states -- transient information from the current conversation</div></div>
<div class="wiki-card"><div class="wiki-card-title">#5 Items</div><div class="wiki-card-desc">Held items, props -- item management</div></div>
<div class="wiki-card"><div class="wiki-card-title">#6 Daily Summary</div><div class="wiki-card-desc">Daily summary information -- review what happened in the past</div></div>
<div class="wiki-card"><div class="wiki-card-title">#7 About the User</div><div class="wiki-card-desc">User preferences, habits, personal info -- AI gets to know the user</div></div>
<div class="wiki-card"><div class="wiki-card-title">#8 Remember Forever</div><div class="wiki-card-desc">Important, unforgettable information -- core settings, important promises</div></div>
<div class="wiki-card"><div class="wiki-card-title">#9 Spatiotemporal Memory</div><div class="wiki-card-desc">Long-term memories related to time and space -- location-associated recollections</div></div>
</div>

## Code Mode Tables

Code Mode uses 6 tables, C0 through C5, oriented toward coding assistance scenarios:

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card"><div class="wiki-card-title">C0</div><div class="wiki-card-desc">Project context</div></div>
<div class="wiki-card"><div class="wiki-card-title">C1</div><div class="wiki-card-desc">Code conventions & standards</div></div>
<div class="wiki-card"><div class="wiki-card-title">C2</div><div class="wiki-card-desc">Current task</div></div>
<div class="wiki-card"><div class="wiki-card-title">C3</div><div class="wiki-card-desc">Tech stack & dependencies</div></div>
<div class="wiki-card"><div class="wiki-card-title">C4</div><div class="wiki-card-desc">Problems & solutions</div></div>
<div class="wiki-card"><div class="wiki-card-title">C5</div><div class="wiki-card-desc">Scratch notes</div></div>
</div>

## Work Mode Tables

Work Mode uses 5 tables, W0 through W4, oriented toward workflow scenarios:

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card"><div class="wiki-card-title">W0</div><div class="wiki-card-desc">Work context</div></div>
<div class="wiki-card"><div class="wiki-card-title">W1</div><div class="wiki-card-desc">Tasks & progress</div></div>
<div class="wiki-card"><div class="wiki-card-title">W2</div><div class="wiki-card-desc">Contacts & collaboration</div></div>
<div class="wiki-card"><div class="wiki-card-title">W3</div><div class="wiki-card-desc">Decision records</div></div>
<div class="wiki-card"><div class="wiki-card-title">W4</div><div class="wiki-card-desc">Scratch notes</div></div>
</div>

## How AI Operates Tables

AI uses the `<tableEdit>` tag in its replies to perform table operations. The system parses the tag and executes the corresponding CRUD action:

- **Create**: Add a new row
- **Read**: Query table contents (usually handled automatically by the recall engine)
- **Update**: Modify an existing record
- **Delete**: Remove an outdated record

The tag uses function-call-style syntax (this is also the operation format injected into the AI by the system):

```
<tableEdit>
<!--
insertRow(tableNumber, {columnNumber: "value", ...})
updateRow(tableNumber, rowNumber, {columnNumber: "newValue", ...})
deleteRow(tableNumber, rowNumber)
-->
</tableEdit>
```

Operations are guided by the memory system's INJ instructions -- INJ-1 tells the AI which tables are available in the current mode, what each table stores, and what format to use for writing.

## Processing Pipeline

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>AI generates a reply</b><small>Reply contains a &lt;tableEdit&gt; tag</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>Backend memory system parses the &lt;tableEdit&gt; tag</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>Locates the corresponding table file by table number</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>Executes CRUD operation writing to the Hot Layer</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>On the next conversation turn</b><small>Hot Layer table content is auto-injected into context</small></div>
</div>

## Tables and the Three-Layer Architecture

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot (Hot Layer)</span>
Currently active table content, injected every turn
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm (Warm Layer)</span>
Recent but no longer active table entries, recalled on demand
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">cold (Cold Layer)</span>
Archived historical entries, reachable via search
</div>
</div>

Table entries are automatically migrated from hot to warm, then to cold over time. Migration is handled automatically by the memory system's archival pipeline.

## Data Table Editor

In [Memory Management](beilu:mode/memory), click the **table** button on the toolbar, or switch to the "Tables" sub-tab in the Memory Content section to open the Data Table Editor.

### Table Switching

The top displays tab pages for #0 through #9 (or C0-C5 / W0-W4, depending on the current viewMode). Click to switch between tables. Each table's name can be directly clicked to edit.

### Cell Editing

Click any cell to enter inline editing mode; changes are auto-saved. Column headers can also be clicked to edit, allowing column name adjustments.

### Rules Section

The rules section below the table defines write rules and format constraints for that table. Each table can be independently configured, and the AI references these rules when writing.

### Row Operations

- **Add row**: Append a new row at the bottom of the table
- **Delete row**: Supports multi-select batch deletion
- **Enable/Disable toggle**: Controls whether table entries participate in Injection

### Search

The table has built-in search functionality to filter matching rows by keyword within the current table.

### Optimistic Concurrency Control

The table editor uses a version number mechanism: each save checks the version number. If another source (such as AI's `<tableEdit>`) has modified the table causing a version mismatch, the system will prompt a conflict to prevent overwrite data loss.

### Snapshots

The table editor can create snapshots of the current table, making it convenient to preserve a backup before making adjustments. See the Snapshot Management section in [Memory Archival & Retrieval](archival.md) for details.

## Important Notes

- Tables for each mode are independent; switching modes loads the corresponding table set
- Table numbers are fixed; the function assigned to each number is defined by INJ-1 instructions
- The format AI uses to write to tables must conform to system parsing requirements; otherwise the write will be ignored
