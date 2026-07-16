# Regex & Render Entries

Usage of regular expression matching and GENERATE/RENDER markers in World Book entries.

## Regular Expression Matching

When an entry has `useRegex: true`, the keywords in key and keysecondary will be matched as regular expressions.

### Basic Usage

| Need | Regex | Match Examples |
|------|-------|----------------|
| Exact word | `magic` | "magician", "learn magic" |
| Word boundary | `\bmagic\b` | Matches only the standalone word "magic" |
| Alternation | `magic\|spell\|incantation` | Matches if any one appears |
| Optional part | `magic(ian)?` | "magic" or "magician" |
| Wildcard | `mag.*ian` | "magician", "mage guardian" |

### Combined with selective

When `selective: true`, both key and keysecondary use regex matching, and both must match simultaneously to trigger.

**Example**:
- key: `forest|jungle|woods`
- keysecondary: `night|midnight|darkness`
- Effect: Only when the conversation simultaneously mentions a "forest-type" word and a "night-type" word is the "nighttime forest" setting injected

### Notes

- Regex special characters (`.` `*` `+` `?` `(` `)` `[` `]` `{` `}` `\` `^` `$` `|`) must be escaped with a backslash if they are intended as literal characters
- The matching scope includes recent content from both user messages and AI replies (the exact scan depth depends on configuration)
- Regex matching is case-sensitive; use the `(?i)` flag when case-insensitive matching is needed

## GENERATE & RENDER Markers

World Book entry content can use two special markers to distinguish the visibility target of information.

### [GENERATE:*] -- AI-Only Visibility

```
[GENERATE:Character inner activity guidance]
When the character is in the forest, include the following sensory details when describing the environment:
- Hearing: birdsong, wind, rustling leaves
- Smell: earth, floral scent, decaying leaves
- Touch: humid air, fallen leaves underfoot
[/GENERATE]
```

Content wrapped in `[GENERATE:*]` appears only in the context sent to the AI and is not displayed in the user interface. Suitable for:

- Writing guidance for the AI
- Character behavior rules
- Internal logic explanations
- Meta-instructions not intended for the user to see directly

### [RENDER:*] -- User-Only Visibility

```
[RENDER:Scene atmosphere text]
--- A dark forest, moonlight filtering through the canopy casting mottled shadows ---
[/RENDER]
```

Content wrapped in `[RENDER:*]` is displayed only in the user interface and is not sent to the AI. Suitable for:

- Scene atmosphere descriptions (decorative text)
- UI hint messages
- Explanatory text for the user
- Content that does not need AI processing but should be visible to the user

### Mixed Usage

A single entry can contain regular content, GENERATE content, and RENDER content simultaneously:

```
This is the setting for the forest area.

[GENERATE:AI writing guidance]
When describing the forest, pay attention to how seasonal changes affect the environment.
[/GENERATE]

[RENDER:User hint]
Hint: You are currently deep within an ancient forest.
[/RENDER]
```

In this example:
- "This is the setting for the forest area." -- visible to both AI and user
- GENERATE section -- visible only to the AI
- RENDER section -- visible only to the user

### Processing Pipeline

```
World Book entry triggers; content enters the injection flow
    ↓
Parse markers in content:
  - Find [GENERATE:*]...[/GENERATE] blocks
  - Find [RENDER:*]...[/RENDER] blocks
  - Remaining portions are regular content
    ↓
When constructing the AI context:
  - Include regular content
  - Include GENERATE block content
  - Exclude RENDER block content
    ↓
When constructing the user display:
  - Include regular content
  - Exclude GENERATE block content
  - Include RENDER block content
```

## Development Notes

- Marker syntax is `[GENERATE:name]` paired with `[/GENERATE]`; the name portion is for identification and does not affect logic
- Markers cannot be nested (no RENDER blocks inside GENERATE blocks)
- Parsing occurs at injection time; if parsing fails (e.g., missing closing tag), the entire content is treated as regular content
- The scan range for regex matching (how many conversation turns to look back) affects trigger sensitivity; too large increases false triggers, too small causes missed triggers
