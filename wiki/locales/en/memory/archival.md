# Memory Archival & Retrieval

Memory archival is the "metabolism" of the memory system: it moves inactive memories from the Hot Layer to the warm and cold layers, while retrieval later attempts to bring relevant memories back. Archival moves data rather than deliberately deleting it, but whether history remains recoverable and recallable still depends on file retention, successful writes and indexing, recall routes, and backups.

## Three-Layer Migration Path

```
hot (Hot Layer)
  ↓ Automatic migration (entry aging / capacity management)
warm (Warm Layer)
  ↓ Further aging
cold (Cold Layer / Archive)
```

### hot → warm Migration

Trigger conditions:
- Memory entry has not been accessed for a certain period
- Hot Layer total capacity is approaching the limit
- After P2 generates a summary and archives, the original detail entries cool down

After migration, entries change from being auto-injected every turn to **on-demand recall**.

### warm → cold Migration

Trigger conditions:
- Warm layer entries continue to age without being recalled for an extended period
- Warm layer capacity management requires it

After migration, entries enter long-term archival and are only reachable via **manual search**.

## Migration Exceptions

The following content **does not participate in migration** and always remains in the Hot Layer:

- Permanent memories in `forever.json`
- Currently active table entries (table rows in use)
- System-level configuration information

## Recall Engine

The recall engine is the core component of the P1 self-driven pipeline, responsible for finding memory entries in the warm/cold layers that are relevant to the current conversation and pulling them into context.

### Recall Process

```
User sends a message
    ↓
NLP tokenization: extract keywords from the user's message
    ↓
Associative expansion: semantically expand keywords
    e.g., "rain" → "rain, weather, umbrella, getting wet, humidity"
    ↓
Multi-word co-occurrence matching: search the warm/cold layers
    - Find entries that contain multiple keywords/associated words simultaneously
    - Multi-word co-occurrence is more precise than single-word matching
    ↓
Four-dimensional scoring (for each candidate entry):
    ↓
Sort and select top-N entries
    ↓
Inject into the current turn's context
```

### Four-Dimensional Scoring Details

| Dimension | Evaluates | Description |
|-----------|-----------|-------------|
| **semantic** | Semantic relevance | How closely the entry content matches the current topic at a semantic level |
| **lexical** | Lexical match | Direct text matching of keywords, high precision |
| **recency** | Temporal recency | More recent memories score higher, reflecting "easier to recall when recent" |
| **importance** | Importance | Memories marked as important score higher, reflecting priority |

Scores from the four dimensions are weighted and summed, then sorted. Weight configuration is adjustable.

### Multi-Word Co-occurrence

Multi-word co-occurrence is the key mechanism for recall precision. Matching a single keyword recalls too many irrelevant entries, whereas requiring multiple keywords to co-occur within an entry significantly improves relevance:

- User says "that cat we met in the park last time" → extracts keywords "park", "cat"
- Entries containing only "park" or only "cat" are not prioritized
- Entries containing both "park" and "cat" receive a high score

## Snapshot Management

In [Memory Management](beilu:mode/memory), click the **snapshot** button on the toolbar, or switch to the "Snapshots" sub-tab in the Memory Operations section.

Snapshots come in two types:

### Memory Snapshots

- **Create**: Click the create button; you can attach a description for the snapshot's purpose
- **Restore**: Select a snapshot from the list; confirm to restore memory to that snapshot's state
- **List**: All created memory snapshots displayed in reverse chronological order

### Git Snapshots

- **Create**: Click the create button; enter a label as the tag identifier
- **Restore**: Select a Git snapshot to restore; the system automatically creates a pre-restore safety snapshot before restoring, preventing data loss from accidental operations
- **List**: All created Git snapshots displayed in reverse chronological order

## Archive Toolbar

In the file browser of [Memory Management](beilu:mode/memory), the top archive toolbar provides the following batch operations:

| Operation | Description |
|-----------|-------------|
| Archive temporary memories | Migrate temporary memory entries from the Hot Layer to the warm layer |
| End today | Execute the end-of-day archival process |
| Hot to Warm | Manually migrate selected Hot Layer entries to the warm layer |
| Warm to Cold | Manually migrate selected warm layer entries to the cold layer |
| Archive completed tasks | Archive memories marked as completed tasks |

These operations supplement the automatic migration mechanism, useful when you need to immediately reorganize memory layers.

## Retrieval Settings

In [Memory Management](beilu:mode/memory), click the **retrieval** button on the toolbar, or switch to the "Retrieval" sub-tab in the Retrieval / Diagnostics section to adjust recall engine parameters:

- **P1 auto-trigger toggle**: Enable/disable P1 auto-recall before each conversation turn
- **Chat citation count**: Control how many recent chat turns are referenced during recall (configured independently per mode)
- **Max search rounds**: Upper limit for P1 multi-round search
- **Timeout**: Search timeout setting

## Format Check

In [Memory Management](beilu:mode/memory), click the **format** button on the toolbar, or switch to the "Format" sub-tab in the Memory Operations section to run format compliance checks on memory files.

- **Scan**: Click the scan button to start the check
- **Statistics**: Shows pass / warning / error / total counts
- **Per-file statistics**: Check results listed for each file
- **Issue list**: Displays details of up to 20 format issues
- **One-click upgrade**: Batch-fix auto-repairable format issues

## Impact on Users

- Archival and recall both happen automatically; users do not need to intervene
- If the AI "forgot" something, it may be because that memory has migrated to the cold layer and was not triggered by the recall engine
- Mentioning relevant keywords in conversation can help the recall engine find related memories in the cold layer
- For particularly important information, it is recommended to have the AI mark it as "remember forever," which places it in forever.json and exempts it from migration

## Notes for Developers

- Time thresholds and capacity thresholds for migration are configurable
- The top-N recall count affects context usage; a balance between recall quality and context space is needed
- Four-dimensional scoring weights can be adjusted based on real-world results
- Associative expansion quality directly impacts recall coverage and is one of the bottlenecks for recall performance
- Cold layer storage has no capacity limit, but search performance should be monitored
