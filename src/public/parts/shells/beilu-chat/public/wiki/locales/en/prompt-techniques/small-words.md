# Small Words, Big Impact

A single precise technical term can be more effective than an entire paragraph of description. This is because in the AI's training data, technical terms are associated with vast amounts of specialized knowledge — use one word and you "activate" the AI's entire corresponding knowledge network.

## The Principle

In the AI's language model, no word is isolated — each is connected to a large network of related concepts. Ordinary vocabulary has a smaller association network, while technical terms have much richer ones.

```
Ordinary vocabulary: "emotion"
  → AI associates: happy, sad, angry...... (vague)

Technical term: "Plutchik's Wheel of Emotions"
  → AI associates: 8 basic emotions, emotion wheel,
    intensity levels of emotions, combination of
    mixed emotions...... (precise and rich)
```

A technical term is like a key that opens the corresponding door in the AI's knowledge base.

## Practical Examples

### Writing Scenarios

| Long description (mediocre effect) | Small words (better effect) |
|-------------------|------------------|
| "The character's emotions should have multiple layers, not just simple happiness or sadness, but complex, mixed emotional states" | "Model the character's emotions after Plutchik's Wheel of Emotions, showing compound emotions" |
| "When arguing, first present a major premise, then a minor premise, and finally draw a conclusion" | "Use syllogistic structure" |
| "Don't have the character explain simple concepts in an overly professional way; they should chat like a normal person" | "Mind the curse of knowledge; the character expresses things from an everyday perspective" |

### Developer Scenarios

| Long description | Small words |
|---------|--------|
| "Each function in the code should do only one thing; don't stuff multiple features into a single function" | "Follow the single responsibility principle" |
| "When writing error handling, consider all possible failure cases, and the system should be able to continue running after errors" | "Defensive programming, ensure graceful degradation" |
| "Design interfaces so users can't easily misuse them" | "Follow the principle of least astonishment" |

## Usage Tips

### 1. Choose the Right Term

Not just any technical term thrown in will be effective. The term must have sufficient coverage in the AI's training data — meaning it's a concept genuinely and widely used in academia or industry.

```
Effective terms (well-covered in the AI's knowledge base):
- Plutchik's Wheel of Emotions (psychology)
- Syllogism (logic)
- Curse of knowledge (cognitive psychology)
- Hero's Journey (narratology)
- Iceberg Theory (writing technique)
- Chekhov's Gun (dramatic theory)

Questionable terms (too niche or too new):
- Self-invented jargon from a small community
- New theories that haven't been widely adopted
```

### 2. Don't Pile Them Up

The value of small words lies in precise activation; piling them up creates signal conflicts.

```
Wrong:
Use syllogism, Socratic method, reductio ad absurdum,
and Hegelian dialectics to organize the character's
dialogue logic.

Correct:
The character's arguments use syllogistic structure,
with counter-questions to advance when necessary.
```

One or two precise terms is enough. Too many terms and the AI tries to satisfy all of them simultaneously, resulting in none being done well.

### 3. You Can Add a Brief Explanation

If you're unsure whether the AI can accurately understand a term in the current context, add a brief clarification:

```
Model the character's emotions after Plutchik's Wheel of Emotions
— in any given scene, the character may simultaneously experience
several different emotions, rather than having only a single
emotional reaction.
```

This both activates the term's knowledge network and limits it to the specific aspect you want.

### 4. Pair with Specific Guidance

Small words are responsible for "calling up knowledge"; specific guidance is responsible for "applying knowledge." The two work best together.

```
Only small words (right direction but not precise enough):
Use Iceberg Theory.

Small words + specific guidance (precise):
Use Iceberg Theory: the character's true thoughts are hinted at
through actions and details, not stated directly through internal
monologue. The subtext of dialogue matters more than its literal meaning.
```

## Quick Reference for Common Small Words

| Domain | Term | Knowledge Activated |
|------|------|-----------|
| Emotional description | Plutchik's Wheel of Emotions | 8 basic emotions, compound emotions, intensity levels |
| Logical expression | Syllogism | Major premise → minor premise → conclusion argument structure |
| Character dialogue | Curse of knowledge | Characters won't speak in ways beyond their own cognition |
| Narrative structure | Hero's Journey | Ordinary → Call → Trials → Transformation → Return |
| Writing technique | Iceberg Theory | Only the tip shows on the surface; deeper meaning is implied |
| Dramatic tension | Chekhov's Gun | Every detail that appears serves a narrative purpose |
| Suspense pacing | Delayed gratification | Don't rush to reveal the answer; release information gradually |
| Code design | Single responsibility principle | One module does one thing |
| Interface design | Principle of least astonishment | Behavior matches the user's intuitive expectation |

## Summary

- Precise technical terms activate the AI's knowledge network, far surpassing long descriptions in effectiveness
- Choose terms that are well-covered in the AI's training data
- Don't pile them up — one or two precise ones is enough
- Pair them with specific guidance to both activate knowledge and limit direction
