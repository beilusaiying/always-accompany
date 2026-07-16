# Few-Shot Prompting

Few-Shot Prompting is a technique where you include 1-3 examples in your prompt, letting the AI learn from them the output style and format you expect. It's one of the most intuitive and effective techniques.

## What Is Few-Shot Prompting

- **Zero-Shot**: No examples, just instructions — "Write a character dialogue"
- **Few-Shot**: 1-3 examples + instructions — "Here are a few dialogue examples, please write in a similar style"
- **Many-Shot**: A large number of examples — generally not recommended, as it easily causes overfitting

The core idea of Few-Shot is: **demonstrating is more effective than describing**. It's hard to precisely describe "natural dialogue pacing" in words, but give two examples and the AI immediately understands.

## Why It Works

AI's learning ability isn't limited to the training phase. During inference, the AI also extracts patterns from examples in the context. Show it a few examples and it will automatically learn:

- The **format** of the output (length, structure, layout)
- The **style** of the output (word choice, sentence patterns, tone)
- The **content boundaries** of the output (what to include, what not to include)

## How to Use It

### Basic Structure

```
[Instructions]
Here is your task description......

[Example 1]
Input: ......
Output: ......

[Example 2]
Input: ......
Output: ......

[Current Task]
Input: ......
```

### Example: Character Dialogue Style

Suppose you want character dialogue to be brief, colloquial, and distinctly personal.

```
Character dialogue should be brief and punchy, reflecting personal
speech habits. Here are examples:

Example 1:
Scenario: A friend invites you out
Character response: "Go where......never mind, I've got nothing
to do anyway. Let's go."

Example 2:
Scenario: Asked about your mood
Character response: "Hm? I'm fine. —Don't look at me like that,
I really am fine."

Now please respond to the current scenario in the style above.
```

The AI can learn from these two examples that:
- The character is taciturn, uses ellipses and dashes
- They add a follow-up remark after their answer
- The tone is neither cold nor warm, casually aloof but with underlying hints

Describing all this in words might take an entire paragraph and still wouldn't be as intuitive as two examples.

### Example: Output Format

```
Response format as follows:

Example:
**Scene**: Classroom during lunch break
**Character action**: Leaning back in the chair, chin resting on
one hand, gazing out the window.
**Character dialogue**: "This weather again......"
**Narration**: Sunlight leaked through the curtain gap, cutting a
line of light across the desk.

Please reply in this format.
```

## Number of Examples

| Count | Effectiveness | Applicable Scenarios |
|------|------|---------|
| 1 | Basically effective, but the AI may over-imitate this single example | Simple format, clear style requirements |
| 2-3 | Optimal balance, the AI can extract commonalities from multiple examples | Most scenarios |
| 4+ | Increased overfitting risk, the AI may become a "example repeater" | Generally not recommended |

It's recommended to give **2-3 examples**. Multiple examples should have differences — different scenarios, different emotional tones, but maintaining the same style. This way the AI learns the "style," not "the answer to this specific scenario."

## Overfitting Risk

### What Is Overfitting

The AI doesn't "learn your style" but rather "memorizes your examples," then repeatedly uses the specific words, sentence patterns, and even plot patterns from the examples in its output.

### Signs of Overfitting

- The AI's output heavily overlaps with the wording of the examples
- The AI uses similar sentence structures across different scenarios
- The AI's output lacks variation, as if following a template

### How to Avoid It

**1. Maintain diversity between examples**

```
Wrong (examples too similar):
Example 1: "Hmph......who'd want to go." ← tsundere avoidance
Example 2: "Hmph, it's not like I care." ← tsundere avoidance
Example 3: "D-don't get the wrong idea!" ← tsundere avoidance

→ AI's conclusion: This character must always be tsundere-avoidant
→ Overfitting: Every scenario becomes a tsundere template
```

```
Correct (examples have differences):
Example 1: "Hmph......who'd want to go." (casual, avoidant)
Example 2: "......Are you okay?" (caring, but restrained)
Example 3: "Here, for you. No need to thank me." (actions over words)

→ AI's conclusion: The character is restrained but expressive in varied ways
→ Won't overfit to a single pattern
```

**2. Pair instructions with examples**

Don't give only examples without instructions. Instructions explain "what you want," examples show "what it looks like" — combining both is most effective.

```
Only examples (high risk):
(Three examples, no explanatory text)
→ AI may over-imitate the specific content of the examples

Examples + instructions (better):
The character is restrained, with actions speaking louder than words.
They tend to use ellipses instead of complete sentences.
Here are a few examples for style reference:
(examples)
```

**3. Control example length**

Don't make examples too long. Short examples help the AI learn style; long examples make the AI memorize content.

## Application in beilu

Both beilu's [Preset entries](../presets/structure.md) and [World Book entries](../memory/worldbook-entries.md) can embed Few-Shot examples. Scenarios suited for Few-Shot:

- **Character Cards**: Include dialogue style examples for the character
- **Writing Presets**: Show the expected output format
- **World Book entries**: Provide response patterns for specific scenarios

> Note: Examples consume tokens. In token-constrained scenarios, a single well-chosen example is sufficient.

## Summary

- Few-Shot Prompting is a technique that directly demonstrates the expected output through examples
- 2-3 diverse examples work best
- Watch for overfitting risk: keep examples diverse, pair with instructions, control length
- Examples help the AI learn "style," not memorize "content"
