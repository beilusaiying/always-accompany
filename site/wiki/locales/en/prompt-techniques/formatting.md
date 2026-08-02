# Formatting and Symbol Usage

The formatting of a prompt — heading levels, symbol markers, visual separators — affects how the AI weighs the content. Proper formatting makes key points stand out and creates clear hierarchy; excessive formatting has the opposite effect.

## Core Principle: Moderation

More formatting symbols is not better. Too much bolding, headings, and dividers create a "saturation bombardment" — when everything is emphasized, nothing is emphasized.

```
Wrong (saturation bombardment):
────────────────
# **Important Rules**
## *Writing Style*
### ⚠️ Notes
- **Must** use **plain narration**
- **Must** maintain **pacing**
- **Absolutely do not** use ~~metaphors~~
---
## **Character Setup**
### ⚡ Core Traits
> ⚠️ **Important**: The character **must** maintain **consistency**

→ Bold, headings, symbols, and dividers everywhere —
  the AI can't tell what's actually important.
```

```
Correct (moderate usage):
────────────────
# Writing Style
Focus on plain narration, keep the pacing brisk.

# Character Setup
The character maintains **core personality** consistency
across different scenarios, but allows emotions and
expression to vary with the scene.

→ Only "core personality" is bolded,
  because it's the most critical concept in this passage.
```

## Heading Levels

### Use Only First-level Headings

In prompts, it's recommended to use only `#` first-level headings to separate modules. Too many levels (`##` `###`) make the structure complex, requiring extra effort from the AI to parse the hierarchy, which actually distracts from the content itself.

```
Wrong (too many levels):
# Writing Guide
## Style
### Narrative
#### Pacing
##### Dialogue Pacing
Keep paragraphs under three lines.

Correct (flat structure):
# Narrative Pacing
Keep paragraphs under three lines; use colloquial short sentences
for dialogue.
```

If content genuinely needs subdivision, natural paragraph separation is sufficient — not every layer needs a heading.

## Emphasis Markers

### Quotation Marks and Bold

Use `""` or `**` to wrap **truly important** content. What counts as truly important? If the AI ignores this word or sentence, the entire output's direction would be off — then it's worth emphasizing.

```
Effective emphasis:
The character's behavior must align with the **current emotional
state**, not the default personality from their profile.

→ "current emotional state" is the key distinguishing point
   in this sentence; without emphasis, the AI might default to
   using the profile personality to drive behavior.
```

```
Ineffective emphasis:
The **character's** **behavior** must **align** with the current
**emotional state**.

→ Bolding everything = bolding nothing.
```

### Usage Recommendations

| Symbol | Purpose | Frequency |
|------|------|------|
| `#` | Module separation | One per major topic module |
| `**bold**` | Key concept emphasis | At most 1-2 per paragraph |
| `""quotes` | Proper nouns or specific expressions | When precise quoting is needed |
| `---` divider | Visual separation between large modules | Occasional use |
| `> blockquote` | Supplementary notes or caveats | Occasional use |

## Common Formatting Issues

### List Overuse

Not all content needs to be turned into a list. When content has logical relationships (sequential, causal), natural language paragraphs work better.

```
Inappropriate list:
- First analyze the character's current emotions
- Then consider how the character would react
- Finally write the character's actions and dialogue

Better approach:
Starting from the character's current emotions, work out the
character's reaction, then express it through actions and dialogue.
```

Lists are suitable for parallel, independent items, such as:
- Multiple characters' traits listed separately
- Several unrelated notes
- Checklist-style format requirements

### Excessive Nesting

```
Wrong:
- Character traits
  - Personality
    - Core personality
      - Calm
    - Secondary personality
      - Occasionally humorous
  - Speech patterns
    - Speech habit
      - "well"
    - Sentence style
      - Short sentences

Correct:
The character is calm, occasionally showing humor.
They use "well" as a speech habit, mainly using short sentences.
```

Deeply nested lists have virtually no positive effect in prompts. The AI won't perform better because your structure is more "complete" — what it needs is clear information, not a polished outline.

## Summary

- **Less is more**: Only use symbols and formatting when emphasis is truly needed
- **Flat over hierarchical**: First-level headings for modules, paragraphs for details — no need for layer upon layer of nesting
- **Be precise with emphasis**: Only emphasize the 1-2 most critical concepts per paragraph
- **Natural language first**: Use paragraphs for logically related content; reserve lists for parallel, independent items
