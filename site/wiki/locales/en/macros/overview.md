# Macros

Write `{{user}}` in a Preset or Character Card, and it automatically becomes your username when the AI replies. All Macros are wrapped in double curly braces and replaced with actual content at runtime.

## Quick Reference

| Syntax | Effect | Example |
|--------|--------|---------|
| `{{user}}` | Your username | `Hello, {{user}}!` → `Hello, Xiao Ming!` |
| `{{char}}` | Current character name | `{{char}} says:` → `Beilu says:` |
| `{{time}}` | Current time | `It is now {{time}}` → `It is now 14:30` |
| `{{date}}` | Current date | `Today is {{date}}` → `Today is July 14, 2026` |
| `{{random::a,b,c}}` | Pick one at random | `Feeling {{random::happy,calm,excited}}` → `Feeling calm` |
| `{{roll:1d6}}` | Roll dice | `Rolled {{roll:1d6}} points` → `Rolled 4 points` |
| `{{setvar::hp::100}}` | Set a variable | Sets local variable hp to 100 |
| `{{getvar::hp}}` | Read a variable | Reads the value of local variable hp |
| `{{trim}}` | Remove whitespace | Cleans up excess line breaks |

## Syntax Rules

Wrap the Macro name in **double curly braces**: `{{macro_name}}`

Separate parameters with **double colons**: `{{macro_name::param1::param2}}`

SillyTavern legacy syntax is supported: `<user>` is equivalent to `{{user}}`, `<bot>` is equivalent to `{{char}}`

## Where to Use Macros

- System prompts, Character Card descriptions, and message templates in [Presets](beilu:editor/persona-edit)
- Various Character Card fields (description, first message, scenario, etc.)
- User message templates and AI reply templates
- Prompt templates for the memory system
- Prompts injected by plugins

## When Macros Are Replaced

### Backend Replacement (Primary)

User sends a message → backend assembles the prompt → Macro replacement → sent to the AI. The vast majority of Macros are replaced at this stage.

### Frontend Replacement (Display Time)

After the AI reply reaches the frontend, `{{char}}` and `{{user}}` are replaced so that character names display correctly. Other Macros do not take effect in replies.

## All Macro Categories

| Category | Description | Typical Examples | Details |
|----------|-------------|------------------|---------|
| Basic Macros | Names, time, format control | `{{user}}` `{{time}}` `{{trim}}` | [Basic Macros](beilu:wiki/macros/basic.md) |
| Advanced Macros | Random, dice, time calculations | `{{random::a,b}}` `{{roll:1d6}}` | [Advanced Macros](beilu:wiki/macros/advanced.md) |
| Variable Macros | Read/write local/global variables | `{{getvar::hp}}` `{{setvar::hp::100}}` | [Variable Macros](beilu:wiki/macros/variables.md) |
| Memory System Macros | Placeholders for the memory module | `{{tableData}}` `{{hotMemory}}` | [Memory System Macros](beilu:wiki/macros/memory.md) |
| IDE/Code Macros | Code Mode exclusive | `{{sub_mode}}` `{{code_file:x}}` | [IDE/Code Macros](beilu:wiki/macros/ide.md) |
| env Custom Macros | Injected by plugins/core via environment | `{{workspace_root}}` `{{active_preset_name}}` | [env Custom Variable Macros](beilu:wiki/macros/env.md) |

## Notes

- Macro names are **case-sensitive**: `{{User}}` is not the same as `{{user}}`
- Unrecognized Macro tokens are **kept as-is** without raising an error
- Macros can be **nested**: the output of one Macro can contain another Macro, which will be further replaced
- Among Macro tokens written in AI reply content, only `{{char}}` and `{{user}}` are replaced by the frontend; other Macros do not take effect in replies
