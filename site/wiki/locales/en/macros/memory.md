# Memory System Macros

Dedicated placeholders used by the beilu-memory plugin when building memory prompts. They are automatically replaced with actual memory data during the memory Injection stage.

> **Note**: Memory System Macros are replaced by the memory system within its own pipeline (the main conversation Injection chain and the memory sub-AI chain each have their own replacement points), independent of the Preset Macro engine. A few Macros (such as `{{lastUserMessage}}`) are also available in the Preset Macro engine context.

## Memory Data Macros

| Macro | Description | Content Source |
|-------|-------------|----------------|
| `{{tableData}}` | Memory Tables data for the current mode | Memory Tables (structured memory) |
| `{{hotMemory}}` | Hot-layer memory | Persistent data such as forever/appointments/user_profile |
| `{{chat_history}}` | Last N chat messages | Chat history |
| `{{lastUserMessage}}` | User's last message | Current conversation |
| `{{contextSummary}}` | Context compression summary | Automatic summary by the memory system |

### {{tableData}}

Memory Tables are one of the core data structures of the always-accompany memory system. Different memory modes (e.g., daily mode, adventure mode) have different table column definitions. `{{tableData}}` is replaced with the table content corresponding to the current mode.

### {{hotMemory}}

Hot-layer memory contains various types of persistent memory data:

- **forever**: Permanent memory entries
- **appointments**: Schedules/commitments
- **user_profile**: User profile information
- And other hot-layer data managed by the memory system

### {{chat_history}}

Injects the last N chat messages, letting the memory AI understand the current conversation context. The exact number of messages is determined by the memory system configuration.

### {{lastUserMessage}}

The last message sent by the user in the current conversation. The memory AI uses it to determine which memories need to be updated.

### {{contextSummary}}

When a conversation becomes too long, the memory system generates a context compression summary. This Macro references that summary content.

## Auxiliary Information Macros

| Macro | Description |
|-------|-------------|
| `{{presetList}}` | List of Presets available to the memory AI |
| `{{current_date}}` | Current date (used internally by the memory system) |

### {{presetList}}

Lists the available Presets for the memory AI to choose from. The memory system needs to know which Presets are available in certain scenarios.

### {{current_date}}

Provides current date information to the memory AI, helping it correctly handle time-related memories (such as schedules, timeline events).

## Processing Pipeline

The replacement flow for Memory System Macros is as follows:

```
User sends a message
  -> beilu-memory plugin activates
  -> Loads memory prompt template (containing Macro placeholders)
  -> Extracts data from memory storage
  -> Replaces {{tableData}}, {{hotMemory}}, etc. with actual data
  -> Assembles the completed memory prompt
  -> Injects it into the main prompt and sends to the AI
```

This process is **independent and parallel** to the main Macro engine — the memory system handles its own Macros, and the processed result is injected into the main prompt as a whole.

## Usage Scenarios

Memory System Macros are mainly used in the following scenarios:

| Scenario | Macros Involved | Description |
|----------|----------------|-------------|
| Memory organization prompt | `{{tableData}}` `{{hotMemory}}` `{{chat_history}}` `{{lastUserMessage}}` | Tells the memory AI what memories exist and what was said in the conversation |
| Context compression | `{{contextSummary}}` | Provides the memory AI with a summary of long conversations |
| Memory format description | `{{presetList}}` `{{current_date}}` | Auxiliary information |

## Notes

- Memory System Macros **cannot** be used in regular Presets or Character Cards — they only take effect within beilu-memory's internal templates
- These Macros are **independently replaced** by the beilu-memory plugin and do not go through the backend core Macro engine
- If you need to reference memory data in a Preset, use the memory system's Injection mechanism rather than writing memory Macros directly
