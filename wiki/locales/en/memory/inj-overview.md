# Injection System (INJ)

## Viewing and Editing INJ Rules

INJ rules determine what information is injected into the AI's context, with what role, and at what position. The system has multiple built-in INJ rules covering table instructions, file-layer prompts, Bot platform prompts, web search instructions, history tags, and more. The key rules are:

| INJ | Name | Function |
|-----|------|----------|
| **INJ-1-chat** | Chat Mode table rules | Tells the AI the purpose and write format of tables #0-#9 in Chat Mode |
| **INJ-1-write-code** | Code Mode table rules | Tells the AI the purpose and write format of tables C0-C5 in Code Mode |
| **INJ-1-work** | Work Mode table rules | Tells the AI the purpose and write format of tables W0-W4 in Work Mode |
| **INJ-2** | File-layer AI prompt | Tells the AI how to operate project files (switches to INJ-2-code variant when IDE is connected) |
| **INJ-3** | Bot platform prompt | Prompts from Bot platforms (e.g., Telegram/Discord) |

There are additional built-in entries such as INJ-4 (Smart Mode capability dispatch), INJ-5 (web search instructions), chat history tags, and more. The three INJ-1 variants are mutually exclusive based on the current work mode -- only the one whose gate matches is active.

Each INJ rule has three key settings:

### autoMode (Gate Mode)

Determines under what conditions an INJ takes effect:

| autoMode | Meaning |
|----------|---------|
| **chat** | Active only in Chat Mode (Chat Mode also accepts the airp alias domain) |
| **code** | Active only in Code Mode |
| **work** | Active only in Work Mode |
| **bot** | Active only in Bot platform mode |
| **always** / **all** | Always active (all modes) |
| **manual** | Manually controlled; active when enabled |
| **file** | Determined by file-layer configuration (active when entering IDE/file mode) |

The Injection domains accepted by the current work mode = unconditional domains (always / all / manual) + file-gated domain (file, only in file mode) + the current mode's own domain and its aliases. An INJ's autoMode must fall within this set to take effect.

### depth (Injection Depth)

Controls where the INJ is placed in the context:

| depth value | Meaning |
|-------------|---------|
| **999** | System prompt level -- at the very front of context, highest priority |
| **0** | After the most recent message -- at the very end of context |
| **N** | Before the Nth conversation turn -- inserted at a specific position in chat history |

The higher the depth, the closer to the system prompt (beginning of context), and the earlier the AI sees it during processing.

### role (Message Role)

The identity under which each INJ message appears:

| role | Meaning |
|------|---------|
| **system** | System message; AI treats it as a system-level instruction |
| **user** | User message; AI treats it as something the user said |
| **assistant** | Assistant message; AI treats it as something it previously said |

The role affects how the AI processes the information. System-level instructions are typically given the highest priority by the AI.

## What INJ Does

The AI's context is not a simple "conversation log." A complete context contains system prompts, Memory Tables, World Book entries, mode instructions, file-layer prompts, Bot platform prompts, and conversation history -- all of which must be assembled in a specific order and position. The INJ system is the rule set for this assembly.

### Processing Pipeline

```
User sends a message
    ↓
System begins constructing context
    ↓
Iterates through all INJ rules:
  1. Check autoMode → does the current mode/platform match?
  2. Check mutual exclusion rules → keep only one of conflicting INJs
  3. Get the INJ's content (may include Macro substitution)
    ↓
Perform Macro substitution on content (~30 types of {{macro}})
    ↓
Sort by depth; place each INJ's content at its corresponding position in context
    ↓
Merge with character settings, conversation history, and World Book entries
    ↓
Final context is sent to AI
```

### Macro Substitution

INJ content can use `{{macro}}` syntax, which is replaced with actual values at injection time. The system provides approximately 30 Macros; common ones include:

- `{{user}}`: current user name
- `{{char}}`: current character name
- `{{time}}`: current time
- `{{date}}`: current date

Macro substitution occurs at injection time (not edit time), ensuring values are always up to date.

### Mutual Exclusion Rules

Certain INJs have mutual exclusion relationships:

- **INJ-1 series**: INJ-1-chat / INJ-1-write-code / INJ-1-work are mutually exclusive; only the one matching the current mode takes effect
- **INJ-2 series**: INJ-2 and INJ-2-code are a mutually exclusive variant pair -- INJ-2-code is used when an IDE is connected; otherwise INJ-2 is used

Mutual exclusion ensures the same type of information is not injected redundantly.

## Navigation

- [INJ Rule Configuration](inj-rules.md) -- Detailed configuration and development notes for each INJ rule
- [Memory System Overview](overview.md) -- How memory enters context through INJ
- [World Book Overview](worldbook-overview.md) -- Injection positions for World Book entries
