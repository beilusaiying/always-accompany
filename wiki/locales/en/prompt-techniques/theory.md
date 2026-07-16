# Prompt Fundamentals

A prompt is the bridge between you and the AI. Writing good prompts is not about stacking instructions, but about understanding how the AI "reads" your words, and then placing information where it's most likely to pay attention.

## Two Questions Before Writing Prompts

Before you start writing any prompt, ask yourself two questions:

1. **Why am I doing this?** — What problem does this prompt solve? Is it because the AI performs poorly in some aspect, or do you want to guide it toward a specific task?
2. **What effect do I need the AI to achieve?** — What should the expected output look like? Not a vague goal like "I want it to write well," but something specific like "I want it to use plain narration, no metaphors, with dialogue driving the plot."

Writing prompts without thinking it through is like driving without a destination.

## Three Functions of a Prompt

Prompts aren't all-powerful, but they can do three things well:

| Function | Explanation | Example |
|------|------|------|
| Tell the AI the task type | Let the AI know what to do right now | "You are a light novel writer, working on a slice-of-life school story" |
| Mitigate poor performance | Correct common AI issues | "Focus on plain narration, avoid heavy use of metaphors and parallelism" |
| Provide precise task requirements | Specific execution guidelines | "Reflect the character's speech habits in dialogue, keep each line under two rows" |

> Note: A prompt is "guidance," not "control." AI is not a program and won't execute every instruction 100% of the time. A good prompt probabilistically improves AI performance rather than absolutely constraining it.

## U-shaped Attention Framework

When AI processes long text, its attention distribution is not uniform. Both research and practice show that AI pays the most attention to the **beginning** and **end** of text, while the middle section tends to be "overlooked." This is U-shaped attention.

```
Attention Intensity
  ^
  |  ██                              ██
  |  ██ ██                        ██ ██
  |  ██ ██ ██                  ██ ██ ██
  |  ██ ██ ██ ██    ░░ ░░   ██ ██ ██ ██
  |  ██ ██ ██ ██ ░░ ░░ ░░ ░░██ ██ ██ ██
  +---------------------------------------->
     Head            Middle            Tail
```

### Three-section Layout

Based on U-shaped attention, prompts should be arranged as follows:

**Head (high attention)** — Place the most important content:
- Identity setup (who you are)
- General task description (what to do)
- Most important rules (rules that must never be violated)

**Middle (low attention)** — Place reference content:
- Conversation history
- Background setting details
- World Book entries
- Supplementary notes

**Tail (high attention)** — Place current action guidance:
- Current specific task
- Reminders for issues to mitigate
- CoT guidance (have the AI think before writing)

### Practical Application

In beilu, the system [Preset](../presets/overview.md) assembly already follows U-shaped principles. But when writing your own Character Cards or custom Presets, also keep this layout in mind:

```
Wrong approach: Burying important rules in the middle of a large block of background description

Correct approach:
  [Head] Identity + core rules
  [Middle] World view, character relationships, background details
  [Tail] Current scene guidance + style reminders
```

## Common Beginner Mistakes

- **The more you write, the better?** — No. Lengthy prompts dilute the focus, and the AI actually has a harder time grasping what's key. Concise and clear is what makes a good prompt.
- **Using commanding language controls the AI?** — No. Too many absolute commands like "you must" or "you absolutely cannot" cause overfitting (the AI becomes rigid). Guiding expressions work better.
- **Writing a prompt once is enough?** — No. Good prompts require repeated testing and iteration, continually adjusting based on the AI's actual performance.

> The following chapters will expand on specific prompt techniques one by one. It's recommended to read them in order, but you can also jump to the parts that interest you based on your needs.
