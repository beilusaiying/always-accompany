# Identity Setup Techniques

Identity setup is the starting point of a prompt. The AI needs to know "who am I" before it can decide "how should I speak and act." A good identity setup points the AI's overall performance in the right direction and keeps the style stable.

## Specific Compound Identities

### Why You Can't Be Vague

"You are a writer" — this is too vague. The AI will default to the average performance of "writer" in its training data, resulting in generic, featureless output.

Identity setup should be **specific**, ideally **compound**, stacking multiple qualifiers to create a precise profile.

### Correct vs. Wrong Examples

```
Wrong: You are a novelist.

Correct: You are an unconventional modern light novel writer.
```

Breaking down this compound identity:
- **Unconventional** — Tells the AI not to follow cliches, avoiding template-like "AI-flavored" writing
- **Modern** — Limits the cultural context and time period
- **Light novel** — Limits the genre style; light novels have their own narrative pacing and dialogue density

Each additional qualifier focuses the AI's output one layer deeper.

### More Compound Identity Examples

| Scenario | Vague identity | Compound identity |
|------|---------|---------|
| Roleplay | You are an AI assistant | You are a war veteran turned retired military doctor, calm in temperament but occasionally revealing dark humor |
| Writing assistance | You are an editor | You are a managing editor specializing in web novel pacing, skilled at cutting out sluggish passages |
| Code assistance | You are a programmer | You are a backend engineer who prefers functional programming and prioritizes code readability |

### The Power of "Unconventional"

In creative scenarios, adding "unconventional" or similar anti-cliche qualifiers can effectively reduce the AI's tendency toward template writing. The AI has been trained on massive amounts of "conventional" writing, so without qualification, it defaults to the "safest" style — which is often the most featureless.

```
Effect comparison:

"You are a romance novelist"
→ AI tends toward: flowery language, extensive psychological description,
  formulaic plots

"You are an unconventional modern romance writer"
→ AI tends toward: more restrained expression, more everyday dialogue,
  more unexpected plot directions
```

## Functional Modularization: AIRP Structure

When the identity setup becomes complex, don't cram everything into a single paragraph. Use a modular approach, with each module responsible for one aspect.

### AIRP Structure

A validated prompt organization structure suitable for roleplay and creative scenarios:

| Module | Content | Purpose |
|------|------|------|
| **A - Actor** | The character's identity definition | Tell the AI "who am I" |
| **I - Instruction** | What to do right now | Tell the AI "what should I do" |
| **R - Reader** | User's preferences and traits | Tell the AI "who am I communicating with" |
| **P - Pitfalls** | Performance to avoid | Tell the AI "what not to do" |

In roleplay scenarios, additional modules can be added:

| Extension Module | Content |
|---------|------|
| Roleplay guidance | Character behavior patterns, speech habits |
| Narrative style | Point of view, tense, pacing |
| Drama style | Conflict handling, emotional expression |
| Writing style | Vocabulary preferences, rhetorical techniques |
| POV (perspective) | Whose perspective narrates |

### Modularization Example

```
Wrong: single-paragraph dump
────────────────
You are an unconventional light novel writer, writing a school
slice-of-life story, the user prefers a lighthearted funny style,
don't use too many metaphors, dialogue should be natural, use first
person, watch the pacing don't drag, characters should have their
own speech habits......
```

```
Correct: modular organization
────────────────
## Identity
You are an unconventional modern light novel writer.

## Task
Develop narratives around school slice-of-life scenarios,
with dialogue driving the plot.

## User Persona
Prefers a lighthearted, humorous tone; enjoys natural interactions
between characters.

## Pitfalls
Avoid lengthy internal monologues and excessive rhetoric.

## Narrative Style
First person, present tense, brisk pacing, snappy scene transitions.

## Writing Style
Focus on plain narration and dialogue; use everyday vocabulary;
character speech should reflect their respective speech habits.
```

Benefits of modularization:
- **Easy to maintain**: If something isn't working, just modify the relevant module instead of rewriting everything
- **Clear hierarchy**: The AI can more accurately understand the requirements for each dimension
- **Reusable**: Effective modules can be reused across characters and scenarios

## Application in beilu

beilu's [Preset system](../presets/overview.md) is inherently modular — each Preset entry is an independent module that can be freely combined. When writing Character Cards or custom Presets, you can directly reference the AIRP structure to organize content, placing different dimensions of guidance in different Preset entries. Character Cards can be edited in the [Editor](beilu:editor/persona-edit).
