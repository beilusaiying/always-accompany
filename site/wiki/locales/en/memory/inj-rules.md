# INJ Rule Configuration

Field definitions, gate logic, and mutual exclusion relationships for each INJ rule.

## INJ Rule Field Reference

Each INJ rule is defined by the following fields:

| Field | Type | Description |
|-------|------|-------------|
| **name** | String | Rule name identifier (e.g., INJ-1-chat) |
| **content** | String | Injection content template, supports `{{macro}}` Macro substitution |
| **autoMode** | Enum | Gate mode: chat/code/work/bot/always/all/manual/file (may also be a custom mode domain name) |
| **depth** | Number | Injection depth: 999=system level, 0=after latest message, N=before the Nth turn |
| **role** | Enum | Message role: system/user/assistant |
| **enabled** | Boolean | Whether the rule is enabled |

## Default INJ Rules in Detail

### INJ-1-chat

- **autoMode**: `chat`
- **depth**: `999` (system prompt level)
- **role**: `system`
- **Function**: Describes the Memory Tables system to the AI for Chat Mode. Content includes the name, stored content, and write format for each table #0-#9, plus syntax documentation for the `<tableEdit>` tag.

**Processing pipeline**: User is in Chat Mode → autoMode matches → INJ-1-chat content is injected as a system message at the very front of context (depth 999) → AI knows how to use Memory Tables.

### INJ-1-write-code

- **autoMode**: `code`
- **depth**: `999`
- **role**: `system`
- **Function**: Describes the Memory Tables system to the AI for Code Mode. Content includes the name, stored content, and write format for each table C0-C5.

### INJ-1-work

- **autoMode**: `work`
- **depth**: `999`
- **role**: `system`
- **Function**: Describes the Memory Tables system to the AI for Work Mode. Content includes the name, stored content, and write format for each table W0-W4.

### INJ-2

- **autoMode**: `file` (determined by file-layer configuration)
- **depth**: configurable
- **role**: `system`
- **Function**: Injects additional AI prompts from character files or Presets. These prompts may contain character-specific behavioral guidance, writing style requirements, etc.

**Mutual exclusion**: When an IDE is connected, the system uses the INJ-2-code variant instead of INJ-2. The two never take effect simultaneously.

### INJ-3

- **autoMode**: `bot`
- **depth**: configurable
- **role**: `system`
- **Function**: Injects prompts specific to Bot platforms (e.g., Telegram, Discord). Includes platform-specific interaction rules, message format constraints, etc.

## autoMode Gate Logic

```
Message received; determine the current environment
    ↓
Iterate through all INJ rules
    ↓
For each rule, check autoMode:
  chat   → Is the current mode Chat Mode? (includes airp alias domain)
  code   → Is the current mode Code Mode?
  work   → Is the current mode Work Mode?
  bot    → Is the current access via a Bot platform?
  always / all → Pass directly (all modes)
  manual → Active when enabled
  file   → Is the current mode file/IDE mode?
    ↓
INJs that pass the gate enter the injection queue
    ↓
Check mutual exclusion relationships; keep only one of any conflicts
    ↓
Perform Macro substitution → sort by depth → inject into context
```

## depth and Context Position

The depth value determines the physical position of the injection within the context. To understand depth, first understand the context structure:

```
[depth 999] System prompt area
  ├─ Character settings
  ├─ INJ-1 table instructions (depth 999)
  └─ Other system-level INJs
    ...
[depth N] Chat history area
  ├─ Turn N
  ├─ ... (World Book atDepth entries inserted here)
  ├─ Turn 2
  ├─ Turn 1
[depth 0] Latest message area
  └─ User's latest message
```

Higher depth values are closer to the front (system level); lower values are closer to the latest message.

## Mutual Exclusion Rules in Detail

### INJ-1 Series Mutual Exclusion

The three INJ-1 rules (chat / write-code / work) are naturally mutually exclusive via autoMode -- only one work mode can be active at a time, so only one INJ-1's autoMode matches.

### INJ-2 vs INJ-2-code

INJ-2 and INJ-2-code are two variants for the same position:

- **INJ-2**: Standard file-layer prompt, for normal conversation scenarios
- **INJ-2-code**: File-layer prompt when an IDE is connected, may include additional code-related guidance

Switching logic: System detects IDE connection → use INJ-2-code; not connected → use INJ-2.

## Macro Substitution Details

Macros are written in `{{macroName}}` format within INJ content and are replaced with actual values at injection time.

**Common Macro categories**:

| Category | Macro examples | Description |
|----------|---------------|-------------|
| Character info | `{{char}}`, `{{charName}}` | Current character name |
| User info | `{{user}}`, `{{userName}}` | Current user name |
| Time info | `{{time}}`, `{{date}}`, `{{weekday}}` | Current time and date |
| System info | `{{model}}`, `{{maxTokens}}` | Current model and configuration |
| Memory info | `{{tableContent_N}}`, `{{memoryCount}}` | Memory Table related |

The complete list of Macro substitutions includes approximately 30 types; refer to the Macro system documentation for the full reference.

## Custom INJ Rules

In addition to the multiple built-in INJs, the system supports adding custom rules. Custom rules require:

1. A unique name identifier
2. content (supports Macros)
3. autoMode gate condition
4. depth injection position
5. role message role

Custom rules follow the same gate and injection logic as default rules.

## Debugging Tips

- Check if an INJ is active: verify that autoMode matches the current mode and enabled is true
- Check injection position: verify that the depth value matches expectations
- Check Macro substitution: verify that `{{macro}}` tags are correctly replaced (misspelled Macros are not replaced and appear as-is)
- Check mutual exclusion conflicts: if an expected INJ is not taking effect, check whether it was excluded by a mutual exclusion rule
