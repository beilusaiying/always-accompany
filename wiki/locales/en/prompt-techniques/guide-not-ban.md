# Guide Rather Than Ban

This is one of the most important principles in prompt writing: **Telling the AI what to do is more effective than telling it what not to do.**

## Why Prohibitive Instructions Are Less Effective

When the AI processes "don't do X," it first has to understand what X is, then try to avoid it. But "avoiding" is a vague behavior — what should it do after avoiding? The AI doesn't know. The result is either over-avoidance (good related performance disappears too) or finding a different way to make the same mistake.

"Do Y" is a clear behavioral direction that the AI can head toward directly.

## Technique One: Replace Bans with Guidance

### Core Principle

Instead of saying "don't do this," say "focus on this."

### Comparison Examples

| Prohibitive (less effective) | Guiding (more effective) |
|----------------|----------------|
| Don't use metaphors | Focus on plain narration |
| Don't write long sentences | Use short sentences, keep the pacing brisk |
| Don't repeat what the user said | Respond in your own words, advance the conversation |
| Don't output irrelevant content | Focus on the current scene, advance one plot point per paragraph |
| Don't use internet slang | Use written colloquial expression |
| No OOC allowed | Always respond in character |

### Practical Writing

```
Wrong:
Don't use metaphors or parallelism. Don't write overly long
psychological descriptions. Don't have the character say things
that don't fit their profile.

Correct:
Focus on plain narration, with dialogue driving the plot.
Express inner thoughts indirectly through actions and micro-expressions.
Character speech should match their respective backgrounds
and speaking habits.
```

Notice: the correct version doesn't just say "don't do what," it also says "do what." After reading it, the AI knows which direction to head.

## Technique Two: Replace Absolute Commands with Guidance

### What Are Absolute Commands

"Must," "absolutely cannot," "never," "always" — these are all absolute commands.

### Why Use Them Sparingly

1. **Overfitting**: Absolute commands cause the AI to raise that rule's priority to extreme levels, squeezing out performance in other areas. For example, "every sentence must reflect the character's personality" makes the AI awkwardly shoehorn personality tags into every line, which actually feels unnatural.
2. **Attention fatigue**: When prompts are full of "must" and "cannot," the AI's attention gets scattered across too many hard constraints, and it actually loses track of what's truly important.
3. **Conflict risk**: Absolute commands easily contradict each other. "Must be concise" and "must describe scenes in detail" placed together leave the AI not knowing which to follow.

### How to Revise

Change "prohibit" to "avoid/reduce," change "must" to "you will/use."

| Absolute command (prone to overfitting) | Guiding expression (more natural) |
|---------------------|-------------------|
| Must use first person | Use first-person narration |
| Absolutely no modern vocabulary | Avoid using obviously modern vocabulary |
| Never exceed three paragraphs | Keep paragraphs concise, typically within two to three |
| You must advance the plot in every reply | You will advance the plot in your replies |

### Exception: When to Use Absolute Commands

When it involves **hard structural requirements**, absolute commands are appropriate:

```
Reasonable absolute commands:
- Reply format must include the [character name]: prefix
- Output must be in JSON format
- Each reply must use "---" to separate multiple characters' dialogue
```

These are structural, binary (right or wrong, no middle ground), so using absolute commands won't cause overfitting.

## Technique Three: Tell the AI How to Do It, Not Just What You Want

### The Problem

Many people writing prompts only describe the desired end result without telling the AI how to achieve it.

```
Wrong:
Write emotionally compelling text.
Make the dialogue flow naturally.
Maintain the character's uniqueness.
```

These all describe "what's good," but the AI doesn't know **how to achieve it**.

### The Correct Approach

Convert "what you want" into "how to do it."

```
Wrong: Make the dialogue flow naturally.

Correct:
Use colloquial short sentences in dialogue; characters interrupt,
pick up each other's lines, and ask counter-questions.
Avoid two characters taking turns delivering long monologues.
Allow characters to be interrupted mid-sentence or go off-topic.
```

```
Wrong: Maintain the character's uniqueness.

Correct:
Character A uses "well" as a filler word and likes rhetorical questions.
Character B is a person of few words; responses are usually no more
than one sentence, occasionally using ellipses instead of a reply.
```

```
Wrong: Write a captivating opening.

Correct:
Open by jumping straight into an ongoing scene.
Start with one of the character's actions or a line of dialogue.
Don't use environment description or background exposition as the opening.
```

### Comparison Summary

| Wishful (describes results) | Guiding (explains methods) |
|------------------|------------------|
| Write with vivid imagery | Build scenes through specific sensory details (sounds, temperature, smells) |
| Make the pacing tighter | Shorten paragraph length, replace description with dialogue and action, skip transitions between scene changes |
| Show character growth | Have the character make different choices in similar situations, showing change through contrast |

## Summary

Three core principles:

1. **Guide instead of prohibit**: Say "focus on X" instead of "don't do Y"
2. **Guide instead of command**: Say "you will/use" instead of "must/absolutely"
3. **Methods instead of results**: Say "how to achieve it" instead of "what to achieve"

Build this habit and you'll see a noticeable improvement in your prompt effectiveness.
