# CoT Chain of Thought

CoT (Chain of Thought) is a technique that has the AI analyze and plan before outputting final content. It's not just a prompt tip — it's a methodology that changes how the AI works.

## What Is CoT

Normally, the AI receives a prompt and directly outputs the result. CoT instead requires the AI to "think first" — analyze the current situation, plan what to do next, organize key points to watch for, and then produce output.

```
Without CoT:
  Prompt → Direct output

With CoT:
  Prompt → Analyze situation → Plan key points → Output
```

This "think before you act" process significantly improves the quality and consistency of AI output.

## Why CoT Works

1. **Guides attention allocation**: During the analysis phase, the AI revisits each requirement in the prompt, ensuring nothing is missed
2. **Reduces deviation**: The planning phase lets the AI determine its direction before writing, rather than making it up as it goes
3. **Improves complex task performance**: For tasks that need to satisfy multiple conditions simultaneously (roleplay, code generation, long-form writing), CoT helps the AI balance multiple constraints

## CoT + Prompt = Maximum Effectiveness

CoT and prompts used together produce results far greater than either alone.

### Example: Roleplay Scenario

```
Prompt without CoT:
────────────────
You are a retired military doctor, calm in personality.
Focus on plain narration, with dialogue driving the plot.

→ The AI may ignore some settings, and the style may be inconsistent.
```

```
Prompt with CoT:
────────────────
You are a retired military doctor, calm in personality.
Focus on plain narration, with dialogue driving the plot.

Before outputting, complete the following analysis in <thinking>:
1. What is the emotional tone of the current scene
2. How would the character react in this situation
3. What plot point should this response advance
4. What style requirements need attention

Then proceed with the output.

→ The AI will review the requirements first, then write content,
  resulting in more stable style and more consistent settings.
```

### Example: Code Assistance Scenario

```
Prompt with CoT:
────────────────
Before answering a programming question, first analyze:
1. What is the user's actual need (not just the surface question)
2. What are the possible implementation approaches
3. Pros and cons of each approach
4. Reasons for the recommended approach

Then provide code and explanation.
```

## CoT as a Debugging Tool

CoT doesn't just make AI output better — it's also a tool for **debugging your prompts**.

### How to Use CoT for Debugging

When the AI's performance doesn't meet expectations, look at its CoT analysis process:

1. **Did the AI understand correctly?** — Check the AI's interpretation of your prompt in the CoT to see if it matches your intent
2. **What is the AI focusing on?** — What aspects did the AI emphasize in the CoT, and what did it overlook
3. **Where did the AI go off track?** — If the final output has issues, find the step in the CoT where it started deviating

### Debugging Example

Suppose you asked the AI to "write a fast-paced fight scene," but the AI produced a long slow-motion description.

Looking at the CoT, you might find:

```
AI's thinking:
"The user wants a fast-paced fight. I need to describe every
 action in detail to showcase how exciting the fight is..."
```

The problem is identified: the AI interpreted "fast-paced" as "detailed." Now you know how to fix the prompt:

```
Before revision: Write a fast-paced fight scene.

After revision: Write a fight scene. Use short sentences,
one action per sentence, don't expand on the details of
each action, and keep paragraphs under three lines.
```

## Using CoT in beilu

beilu's [Preset system](../presets/overview.md) supports embedding CoT guidance in system prompts. You can:

- Add CoT analysis steps at the end of a Character Card
- Configure thinking guidelines in Preset entries
- Use tail Injection to place CoT prompts for the current scene

Placing it at the tail works best (following the U-shaped attention principle), because CoT guidance is about "what to do right now" and belongs in the high-attention zone.

## Notes

- CoT increases the AI's output length (the analysis portion also counts as tokens), so watch your token usage
- Not every scenario needs CoT. Simple Q&A and casual chat don't need it; complex creation and multi-constraint tasks do
- Keep CoT analysis steps to 3-5. Too many steps can cause the AI to go off track during the analysis phase itself
- Some models support built-in thinking features (like Claude's extended thinking), which can be used in combination with CoT guidance in prompts
