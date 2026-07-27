# Variable Macros

**Store and read data** in Presets and Character Cards for state tracking (affinity, HP, item count, etc.). Divided into **local variables** (specific to the current character/chat) and **global variables** (shared across all characters), with fully symmetrical operations.

## Core Concepts

### Variable Storage Location

Variable data is stored in `macroMemory` and persisted to the Preset's `macro_variables` field. This means:

- Variables are **persistently retained** across conversations and are not lost when the page is refreshed
- Local variables are bound to the current character/chat
- Global variables are shared among all characters

### Variable Types

Variable values can be **strings** or **numbers**. When performing math operations (add/inc/dec), the system attempts to treat the value as a number.

## Local Variable Operations

Local variables are only valid within the scope of the current character/chat.

| Macro | Description | Example |
|-------|-------------|---------|
| `{{setvar::name::value}}` | Set a variable | `{{setvar::hp::100}}` |
| `{{getvar::name}}` | Read a variable | `{{getvar::hp}}` -> `100` |
| `{{addvar::name::value}}` | Add a numeric value | `{{addvar::hp::-20}}` (hp becomes 80) |
| `{{incvar::name}}` | Increment by 1 | `{{incvar::turn}}` |
| `{{decvar::name}}` | Decrement by 1 | `{{decvar::hp}}` |

### Usage Examples

**Set initial state** (in the Character Card's first message):
```
{{setvar::hp::100}}{{setvar::mp::50}}{{setvar::gold::0}}
The adventure begins! {{user}}'s initial status: HP {{getvar::hp}} / MP {{getvar::mp}}
```

**Take damage in combat**:
```
{{addvar::hp::-15}}
{{char}}'s attack hits! {{user}} takes 15 damage, remaining HP: {{getvar::hp}}
```

**Turn counter**:
```
{{incvar::turn}}
=== Turn {{getvar::turn}} ===
```

## Global Variable Operations

Global variables are shared across all characters and chats. The operation functions are fully symmetrical with local variables, with a `global` prefix added to the name.

| Macro | Description | Example |
|-------|-------------|---------|
| `{{setglobalvar::name::value}}` | Set a global variable | `{{setglobalvar::reputation::neutral}}` |
| `{{getglobalvar::name}}` | Read a global variable | `{{getglobalvar::reputation}}` |
| `{{addglobalvar::name::value}}` | Add a numeric value | `{{addglobalvar::total_kills::1}}` |
| `{{incglobalvar::name}}` | Increment by 1 | `{{incglobalvar::day_count}}` |
| `{{decglobalvar::name}}` | Decrement by 1 | `{{decglobalvar::energy}}` |

### Usage Examples

**World state shared across characters**:
```
{{setglobalvar::world_time::morning}}
{{setglobalvar::weather::sunny}}
```

Different characters' Presets can all read:
```
It is now {{getglobalvar::world_time}}, weather is {{getglobalvar::weather}}.
```

**Cumulative statistics across conversations**:
```
{{incglobalvar::total_chats}}
This is your conversation number {{getglobalvar::total_chats}}.
```

## Local vs Global: How to Choose

| Scenario | Recommended | Reason |
|----------|-------------|--------|
| Character affinity | Local variable | Independent per character |
| HP/MP/status | Local variable | Belongs to the current character's adventure |
| Global time/weather | Global variable | Shared world for all characters |
| Player achievements/stats | Global variable | Accumulated across characters |
| General setting preferences | Global variable | Not dependent on a specific character |

## Complete Operation Comparison Table

| Operation | Local Variable | Global Variable |
|-----------|---------------|----------------|
| Set | `{{setvar::key::val}}` | `{{setglobalvar::key::val}}` |
| Read | `{{getvar::key}}` | `{{getglobalvar::key}}` |
| Add | `{{addvar::key::N}}` | `{{addglobalvar::key::N}}` |
| Increment | `{{incvar::key}}` | `{{incglobalvar::key}}` |
| Decrement | `{{decvar::key}}` | `{{decglobalvar::key}}` |

## Notes

- Reading a non-existent variable returns an empty string without raising an error
- `addvar` can take a negative number for subtraction: `{{addvar::hp::-10}}`
- `setvar` overwrites the existing value
- Variable names should use English letters and underscores; avoid special characters
- Both setting and reading variables occur during the backend Macro replacement stage (before sending to the AI)
