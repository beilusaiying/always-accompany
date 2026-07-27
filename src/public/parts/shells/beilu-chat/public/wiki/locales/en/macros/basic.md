# Basic Macros

Name insertion, time and date, format control. No parameters needed — just write them and they work.

## Name Macros

Insert the username or character name.

| Macro | Alias | Description | Example Output |
|-------|-------|-------------|----------------|
| `{{user}}` | `<user>` | Display name of the current user | `Xiao Ming` |
| `{{char}}` | `<bot>` `<char>` | Display name of the current character | `Beilu` |

### Usage Examples

In a Character Card description:
```
{{char}} is a gentle girl who always cares about {{user}}'s feelings.
```
After replacement:
```
Beilu is a gentle girl who always cares about Xiao Ming's feelings.
```

In the first message:
```
"{{user}}, you look really happy today!" {{char}} said with a smile.
```
After replacement:
```
"Xiao Ming, you look really happy today!" Beilu said with a smile.
```

> **Tip**: `{{char}}` and `{{user}}` are the only Macros that are also replaced on the frontend (when displaying AI replies). All other Macros are only replaced on the backend (before sending to the AI).

## Time and Date Macros

Insert the current time and date so the AI can perceive "now."

| Macro | Description | Example Output |
|-------|-------------|----------------|
| `{{time}}` | Current time (localized short format) | `14:30` |
| `{{date}}` | Current date (localized long format) | `July 14, 2026` |
| `{{weekday}}` | Current day of the week | `Monday` |
| `{{isotime}}` | 24-hour format time | `14:30` |
| `{{isodate}}` | ISO format date | `2026-07-14` |

### Usage Examples

Providing time awareness in the system prompt:
```
Current time: {{time}}
Current date: {{date}} ({{weekday}})
```
After replacement:
```
Current time: 14:30
Current date: July 14, 2026 (Monday)
```

## Message Time Macros

Get time information of the last message in the chat.

| Macro | Description | Example Output |
|-------|-------------|----------------|
| `{{lasttime}}` | Time of the last message | `14:25` |
| `{{lastdate}}` | Date of the last message | `July 14, 2026` |
| `{{idle_duration}}` | Time elapsed since the last message | `5 minutes` |

### Usage Examples

Let the AI perceive conversation intervals:
```
It has been {{idle_duration}} since the last conversation.
```
After replacement:
```
It has been 2 hours since the last conversation.
```

## Format Control Macros

Control prompt text formatting without producing visible content.

| Macro | Description |
|-------|-------------|
| `{{newline}}` | Insert a line break |
| `{{trim}}` | Remove blank lines around the Macro's position |
| `{{noop}}` | No-op, replaced with an empty string |

### Usage Examples

`{{trim}}` is commonly used to eliminate extra blank lines produced during template concatenation:

```
This is the first paragraph.
{{trim}}
This is the second paragraph.
```

Without `{{trim}}`, extra blank lines may appear during concatenation. With it, blank lines are cleaned up, producing compact and tidy output.

`{{noop}}` can be used as a "placeholder" — marking a position in a template without producing any output.

## Quick Reference Table

| Macro | Alias | Type | Replacement Stage |
|-------|-------|------|-------------------|
| `{{user}}` | `<user>` | Name | Backend + Frontend |
| `{{char}}` | `<bot>` `<char>` | Name | Backend + Frontend |
| `{{time}}` | - | Time | Backend |
| `{{date}}` | - | Date | Backend |
| `{{weekday}}` | - | Date | Backend |
| `{{isotime}}` | - | Time | Backend |
| `{{isodate}}` | - | Date | Backend |
| `{{lasttime}}` | - | Message time | Backend |
| `{{lastdate}}` | - | Message time | Backend |
| `{{idle_duration}}` | - | Message time | Backend |
| `{{newline}}` | - | Format | Backend |
| `{{trim}}` | - | Format | Backend |
| `{{noop}}` | - | Format | Backend |
