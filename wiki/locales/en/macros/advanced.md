# Advanced Macros

Random selection, dice rolling, text processing, time calculations, and more. Most require parameters, separated by double colons `::`.

## Random and Selection

### {{random::option list}}

**Randomly** picks one from a comma-separated list of options. The result may differ each time.

```
{{random::sunny,cloudy,rainy,snowy}}
```

Possible output: `rainy`

**Use case**: Add randomness and variety to conversations.

Example — random opening mood for a character:
```
{{char}}'s mood today is {{random::happy,calm,melancholy,excited,lazy}}.
```

### {{pick::option list}}

**Deterministically** picks one from a comma-separated list of options. The same input in the same context always returns the same result.

```
{{pick::spring,summer,autumn,winter}}
```

Output: `autumn` (always the same result in the same context)

**Difference from random**: `random` may produce different results each time; `pick` produces a fixed result in the same context. Use `pick` when you need stability, and `random` when you want variation.

## Dice Rolling

### {{roll:NdM}} / {{roll:NdM+K}}

Simulate rolling dice. `N` is the number of dice, `M` is the number of faces, and `K` is an optional modifier.

| Syntax | Meaning | Result Range |
|--------|---------|--------------|
| `{{roll:1d6}}` | Roll 1 six-sided die | 1–6 |
| `{{roll:2d10}}` | Roll 2 ten-sided dice, sum them | 2–20 |
| `{{roll:1d20+5}}` | Roll 1 twenty-sided die, add 5 | 6–25 |
| `{{roll:3d6-2}}` | Roll 3 six-sided dice, subtract 2 | 1–16 |

### Usage Examples

Skill check in roleplay:
```
{{user}} attempts to pick the lock and rolls {{roll:1d20+3}} (DC 15).
```
Possible output:
```
Xiao Ming attempts to pick the lock and rolls 18 (DC 15).
```

Combat damage calculation:
```
{{char}} swings the sword to attack! Deals {{roll:2d6+4}} damage.
```

## Text Processing

### {{reverse::text}}

Reverses the text.

```
{{reverse::Hello World}}
```
Output: `dlroW olleH`

```
{{reverse::你好世界}}
```
Output: `界世好你`

## Time Calculations

### {{timediff::time1::time2}}

Calculates the difference between two points in time, returning a human-readable duration description.

```
{{timediff::2026-01-01::2026-07-14}}
```
Output: a human-readable representation of the time difference

**Use case**: Express "how long since an event" or "how long until a point in time" in prompts.

## Time Zones and Formatting

### {{time_utc+N}}

Get the current time at a specified UTC offset. `N` is the UTC offset.

| Syntax | Meaning |
|--------|---------|
| `{{time_utc+8}}` | UTC+8 time |
| `{{time_utc+9}}` | UTC+9 time |
| `{{time_utc-5}}` | UTC-5 time (US Eastern Standard) |
| `{{time_utc+0}}` | UTC time |

Example:
```
Tokyo time: {{time_utc+9}}
```

### {{datetimeformat FORMAT}}

Output the current date and time using a custom format string. The format follows standard date-time formatting syntax.

```
{{datetimeformat YYYY-MM-DD HH:mm}}
```
Possible output: `2026-07-14 14:30`

```
{{datetimeformat MM/DD/YYYY}}
```
Possible output: `07/14/2026`

## Special Purpose Macros

### {{banned "word"}}

Marks a banned word. Used in prompts to tell the AI that certain words should not be used.

```
{{banned "some word"}}
```

### {{//comment content}}

Comment Macro. The content is completely removed and will not appear in the final prompt. Useful for writing notes in Preset templates.

```
{{//This is a note for the Preset editor; the AI will not see it}}
The actual prompt content goes here.
```

## Quick Reference Table

| Macro | Parameters | Description | Determinism |
|-------|-----------|-------------|-------------|
| `{{random::list}}` | Comma-separated options | Pick one at random | Random |
| `{{pick::list}}` | Comma-separated options | Pick one deterministically | Deterministic |
| `{{roll:NdM}}` | Dice expression | Roll dice | Random |
| `{{reverse::text}}` | Any text | Reverse text | Deterministic |
| `{{timediff::t1::t2}}` | Two time points | Calculate time difference | Deterministic |
| `{{time_utc+N}}` | UTC offset | Time in a specified time zone | Deterministic |
| `{{datetimeformat FMT}}` | Format string | Custom date format | Deterministic |
| `{{banned "word"}}` | A word | Banned word marker | - |
| `{{//comment}}` | Comment content | Comment (removed) | - |
