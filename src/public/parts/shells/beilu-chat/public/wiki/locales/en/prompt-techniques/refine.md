# Refinement and Iteration

Prompts are not better when longer, and they're never done after a single draft. Refinement helps the AI focus on what matters; iteration makes prompts better over time.

## Remove Useless Prompts

### Three Common Types of "Useless"

**1. Bilingual headings**

```
Wrong:
## Writing Style / 写作风格
Your writing focuses on plain narration......

## Character Voice / 角色语言
Character dialogue should be natural......
```

Bilingual headings don't help the AI understand better — they just waste tokens and scatter attention. The AI can fully understand headings in a single language.

```
Correct:
## Writing Style
Your writing focuses on plain narration......

## Character Voice
Character dialogue should be natural......
```

**2. Content homogenization (saying the same thing repeatedly)**

```
Wrong:
Dialogue should be natural. The exchange between characters should
feel like real conversation. Avoid stiff lines; make the characters'
language close to everyday speech. Every character's way of speaking
should sound as natural as a real person.
```

These four sentences say the same thing. The AI won't pay more attention because you said it four times — in fact, the repetition dilutes the weight of other points.

```
Correct:
Use colloquial short sentences for character dialogue;
allow interruptions, pick-ups, and tangents.
```

One sentence is enough, and it's clearer than four.

**3. Excessive direct examples**

```
Wrong:
For example, Character A says "What nice weather today," Character B
replies "Yeah, I really want to go out," then Character A says "Let's
go to the park," Character B says "Sure sure"......
(over a dozen rounds of example dialogue)
```

Too many direct examples cause the AI to **overfit** — it doesn't learn "how to write dialogue" but instead memorizes "this is exactly how dialogue should be written," and the output becomes a repetition of your examples.

A small number of carefully selected examples is what's effective. (See the "Few-Shot Prompting" chapter for details.)

## Refine but Avoid Wishful Thinking

### What Is Wishful Thinking

Wishful thinking means treating "the desired end effect" as prompt guidance.

```
This is wishful thinking:
Write a captivating story.
Make the reader feel immersed.
Create unforgettable characters.
```

These words describe characteristics of "a good novel," but the AI doesn't know **how to achieve them**. It's like telling someone "make the food delicious" — they need a recipe, not just the words "make it delicious."

### Refinement Does Not Equal Wishful Thinking

Refinement means removing fluff while keeping effective guidance. Wishful thinking means removing the methods and keeping only the wishes.

| Wishful (ineffective) | Refined effective guidance |
|------------|--------------|
| Write scenes with vivid imagery | Build scenes with specific sensory details: temperature, sounds, smells |
| Make dialogue feel real and natural | Use colloquial short sentences for dialogue; allow interruptions and tangents |
| Create characters with depth | Have characters reveal value conflicts through difficult choices |
| Keep the article's pacing tight | Keep paragraphs under three lines; skip transitions between scene changes |

### Refinement Checklist

After writing a prompt, check each item:

1. **Can this item guide the AI's specific behavior?** — Yes, keep it; no, rewrite or delete it
2. **If I remove this item, will the AI perform worse?** — Yes, keep it; no, delete it
3. **Does this item duplicate another?** — If duplicate, merge into one

## Prompt Iteration

Good prompts aren't written — they're revised.

### A/B Testing

For the same scenario, generate with two versions of the prompt and compare results.

```
Version A:
Focus on plain narration, avoid metaphors.

Version B:
Focus on plain narration, reduce the frequency of metaphor usage.

Same input → Compare outputs from both versions → Pick the better one
```

Change only one thing at a time — that way you can tell which change made the difference. If you change three things at once and the result improves, you won't know which one was responsible.

### Break Down the Problem

When the AI performs poorly, don't just say "it's bad" in general. Break the problem down into specific aspects:

```
Vague: "The AI's dialogue is bad"

Broken down:
- Dialogue too long? → Add "each character speaks no more than two sentences"
- Dialogue too formal? → Add "use colloquial expressions"
- Characters indistinguishable? → Give each character specific speech traits
- Dialogue doesn't advance? → Add "advance one information point per dialogue turn"
```

After breaking it down, each problem has a targeted solution, making fixes much more efficient.

### Analyze Failure Cases

When the AI produces poor content, don't just think "that's bad" and regenerate. Analyze **why it's bad**:

1. **Look at what the AI actually wrote** — Specifically where it doesn't meet your requirements
2. **Compare with your prompt** — Does your prompt cover this aspect? If not, add it. If it does, change the wording
3. **Look at the CoT** (if available) — How did the AI interpret your requirements during the analysis phase? Was there a misunderstanding?

### Iteration Loop

```
Write prompt
    ↓
Test (generate multiple times, assess overall performance)
    ↓
Identify problems (break down into specific aspects)
    ↓
Analyze causes (prompt didn't cover it? Covered but poorly worded?)
    ↓
Modify prompt (change one thing at a time)
    ↓
Test again
    ↓
(Loop until satisfied)
```

## Summary

- **Remove useless content**: Repetitive, bilingual, excessive examples — all noise
- **Refinement does not equal wishful thinking**: Keep guidance that directs specific behavior; delete wishes that only describe outcomes
- **Iteration is the path to improvement**: A/B testing, problem breakdown, failure analysis — this is the right way to improve prompts
