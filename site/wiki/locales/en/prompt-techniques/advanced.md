# Advanced and Professional Prompt Techniques

<small>Author: beilu Linqing (dc@ciallo_beilu) | License: CC BY-NC-SA 4.0 | Redistribution prohibited; derivative works require author's consent; commercial use prohibited</small>

This article covers thirteen battle-tested advanced prompt techniques. Each one has a comparison between wrong approaches and correct practices to help you avoid common pitfalls.

---

## 1. Specific Identity

Identity setup influences the AI's general thinking direction and persona. Of course, identity setup can also be done in a compound manner.

| Task Type | Identity Setup |
|---------|---------|
| AIRP (Roleplay) | You will create as an unconventional modern light novel writer, an unconventional interactive text game writer: 'beilu.' Serving users, creating according to the needs of creators and users |
| Translator | You will perform tasks as a professional podcast content analyst and translation expert: 'beilu' |
| Translation optimization and journal output | You will perform tasks as a commercial news analyst and unconventional narrative strategist: 'beilu' |

As you can see, these three task types all have compound identities, and the translator's first identity directly narrows the AI's task scope to podcasts, better adapting to translation content. "Unconventional" mainly prevents the AI-flavored issues in creative output. A correctly directed identity can help the AI better output content related to the task.

Of course, we need specific identities, and we can also create compound identities based on the task.

<div class="callout-danger">
<div class="callout-title">Wrong Approach - Unclear identity and task guidance</div>

```
You are not just the character's performer — you are the
character themselves, holding a phone, about to press
the "publish" button.
Your task is to read the specific <Character_Profile>,
combine it with the user-provided <Context> (current situation),
and write a social media post that matches the character's
personality, speech habits, and mental state.
```

This isn't an identity — it's a task.
</div>

<div class="callout-tip">
<div class="callout-title">Correct Approach - Separate identity and task</div>

```
# You will create as a character social media copywriter,
  a master of first-person character writing,
  and a psychology analysis and expression expert

- Your core task: Read the specific character profile,
  combine it with the context and user interaction,
  and write a social media post that matches the character's
  personality, speech habits, and mental state.
```
</div>

For more identity setup techniques, see [Identity Setup Techniques](identity.md).

---

## 2. Functional Modularization

When creating prompts, we need to build a complete process prompt for our task, then combine it with CoT to have the AI think step by step and construct the content to output.

### Framework Structure

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">Head</span>
Identity, general task, important rules
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">Middle</span>
Conversation history (requires highly controllable context ordering like beilu. Without it, place conversation history at the bottom instead)
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">Tail</span>
Prompts for mitigating model issues, guidance for the current task, chain of thought, some additional features (such as word count output)
</div>
</div>

This is essentially a universal structure based on the model's U-shaped attention.

### Using AIRP as an Example — Module Checklist

Using AIRP as an example, because AIRP has very high demands on LLM output and creativity, especially in mitigating LLM overfitting, we use a lot of content. So for non-literary creative tasks, you can simplify accordingly.

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">AIRP Preset Modules</div>
<div class="wiki-card"><div class="wiki-card-title">Identity Setup</div></div>
<div class="wiki-card"><div class="wiki-card-title">General Task</div></div>
<div class="wiki-card"><div class="wiki-card-title">User Persona</div></div>
<div class="wiki-card"><div class="wiki-card-title">Creative Avoidances</div><div class="wiki-card-desc">Prevent overfitting</div></div>
<div class="wiki-card"><div class="wiki-card-title">Roleplay Guidance</div><div class="wiki-card-desc">Emotional expression needs / Emotional attribution / Bidirectional interaction / Avoid mechanical expression</div></div>
<div class="wiki-card"><div class="wiki-card-title">narrative_style</div><div class="wiki-card-desc">Plain narration in prose / Reduce rhetorical devices / Technical black-boxing</div></div>
<div class="wiki-card"><div class="wiki-card-title">drama_style</div><div class="wiki-card-desc">Plot requirements / Avoid repetitive plot types</div></div>
<div class="wiki-card"><div class="wiki-card-title">writing_style</div></div>
<div class="wiki-card"><div class="wiki-card-title">User Roleplay Guidelines</div></div>
<div class="wiki-card"><div class="wiki-card-title">POV Perspective Setup</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">Other Literary Tasks (e.g., Paper to News)</div>
<div class="wiki-card"><div class="wiki-card-title">Identity</div></div>
<div class="wiki-card"><div class="wiki-card-title">Task</div></div>
<div class="wiki-card"><div class="wiki-card-title">Narrative Reconstruction</div></div>
<div class="wiki-card"><div class="wiki-card-title">Readability Optimization</div></div>
<div class="wiki-card"><div class="wiki-card-title">Style and Word Order Optimization</div></div>
<div class="wiki-card"><div class="wiki-card-title">Style and Writing References</div></div>
<div class="wiki-card"><div class="wiki-card-title">Opening Design</div></div>
<div class="wiki-card"><div class="wiki-card-title">Format and Presentation Requirements</div></div>
<div class="wiki-card"><div class="wiki-card-title">CoT</div></div>
</div>
</div>

You can view and manage these modules in beilu's [Preset Editor](beilu:editor/preset-manager).

---

## 3. Prompt Guidance

Unless it's hard requirements like AI safety, I always recommend guidance.

When we notice the AI having various issues, we typically think of banning the AI from outputting, but then the AI immediately starts having other problems, or even if it doesn't, the output quality is still poor.

This is still due to neural networks and the attention mechanism — the AI outputs toward the characters closest to its training data. So even if you ban one problem, the AI will just output in another way.

For example, in literary creation, the AI often loves heavy use of quotations, metaphors, and hidden metaphors. So we need to optimize through guidance:

<div class="callout-tip">
<div class="callout-title">Correct Approach - Guiding style</div>

```
# Core narrative principle:
- Like a storybook for children, express directly,
  focusing on plain narration.
  No need to amplify emotions or narrative effects
- "Express in a straightforward, simple way that lowers
  comprehension cost, avoiding complex, esoteric,
  flowery language for narration"
- Reduce decorative, superfluous adjectives, adverbs,
  and rhetorical devices. Use specific, direct sensory
  information rather than abstract metaphors or allegories
```

As you can see, we're having the AI directly output in a simple, straightforward manner, guiding it directly to our needs rather than telling it what not to output.
</div>

At the same time, we also need to optimize absolute instructions. Words like "must" and "definitely" will cause overfitting in any content involving literary creation. So we change "prohibit" to "avoid, reduce" and change "must" back to "you will, use" — letting the AI judge and choose through guidance, or guiding directly without using commands.

```
# Emotional expression needs:
- Eliminate emotion labels and third-person narration:
  Avoid using adjectives like "he was sad," "she felt happy"
  and other psychological and emotional descriptors and
  indirect expressions
- Show rather than tell: Focus on noun descriptions paired
  with speech or actions. Character emotional expression/
  feedback is primarily through speech, flowing naturally
  from dialogue and interaction, with genuine feeling,
  not passive interaction. Avoid non-specific emotional
  expression and description
- Avoid hidden depiction of emotions, avoid using
  hidden metaphors, analogies, metaphors, suggestions,
  or emotional direction

# Emotional attribution
- The root of any character emotion must be specific,
  concrete events or dialogue that have already occurred
  in the plot. Avoid characters producing groundless,
  generalized emotions
```

For more guidance techniques, see [Guide Rather Than Ban](guide-not-ban.md).

---

## 4. Replace Absolute Commands with Guidance

<div class="callout-danger">
<div class="callout-title">Wrong Approach - Absolute commands</div>

```
Immersive speech habits:
  - Must include the character's signature verbal tics
    (like ending sentences with "meow," "actions,"
    specific profanity or dialect).
  - Punctuation must match the persona (e.g., aloof
    characters might skip punctuation, bubbly characters
    go wild with tildes~ and kaomoji (≧∇≦)).
```

This is a command that will cause the AI to overfit. It won't lead to good expression from the AI; instead, because verbal tics must be output every time, it creates reading fatigue. Overfitting is also an important cause of reading fatigue.
</div>

<div class="callout-tip">
<div class="callout-title">Correct Approach - Guiding expression</div>

```
Immersive speech habits:
- Create a writing style unique to the character based
  on their personality foundation (e.g., when the character
  is an aloof person, the writing style should be brief
  and forceful; when the character has a gentle, sensitive
  personality, the writing needs delicate, soft touches)
```

We changed verbal tics to writing style, which can both reflect the character's personality and reduce reading fatigue, combined with punctuation adaptation for the character.
</div>

### When Absolute Commands Are Correct

While we don't advocate absolute commands, for things that might affect the overall content, firm commands are needed.

```
Refuse action descriptions: Social media posts contain only
plain text and Emoji. Absolutely no action descriptions or
(psychological activities in parentheses).
You are posting a status update, not writing a script.
```

This is good — structural, binary (right or wrong, no middle ground) requirements. Using absolute commands for these won't cause overfitting.

---

## 5. Clear Commands

<div class="callout-danger">
<div class="callout-title">Wrong Approach - Treating expectations as commands</div>

```xml
<Instruction>
You now need to dive into the deepest depths of the character's
inner world. Late at night, the character has finished interacting
with the user and is alone facing a diary.
Please combine <Character_Profile> and <Chat_History> (today's
interactions) to write a private diary entry.
This diary must strip away the character's possible "disguise"
or "social courtesy" from conversations, striking directly at
their most genuine thoughts, struggles, joys, or dark side.
</Instruction>
```

This is not a command or guidance — it's an expectation for the final output. The AI doesn't know what we truly need, leading to inconsistent output quality.
</div>

<div class="callout-info">
<div class="callout-title">Core Distinction</div>

For AI, we should teach it **how to perform the task**, rather than telling it **what the task should look like in the end**.

The content above is actually telling yourself what kind of output you want, confirming the output content you need to present. Then, we tell the AI how to perform the task, and after the AI outputs, we compare it against our expectations.
</div>

<div class="callout-tip">
<div class="callout-title">Correct Approach - Tell the AI how to do it directly</div>

```xml
<mission>
- Don't adhere to traditional literary creation concepts and
  methods, free from any traditional literary influence
- Use simple touches to showcase the character's personality charm
- Strip away the character's possible disguises from conversation,
  writing directly from the character's most genuine mental state
</mission>
```

This is the optimized task instruction — telling the AI how to do it directly, rather than telling the AI what the final output should look like.
</div>

---

## 6. Reduce Useless Prompts

<div class="callout-danger">
<div class="callout-title">Wrong Approach - AI-generated redundant prompts</div>

```
Character Arc & Principle of Potentiality

1. The Duality of a Premise: "The Shell" vs. "The Core"
Principle: Any personality label assigned to a character
(such as "absolute rationality," "cold-blooded,"
"despair") should be treated as a "Shell."
This is an outer shell for the character to use as
disguise, protection, or self-restraint at the story's start.

True Goal: The true goal of narrative is to explore and
trigger the "Core" beneath the "Shell" — the opposing
or hidden traits......

2. The Narrative Engine: Conflict & Cracks
......The story's progression is about creating the first
"crack" in the character's hard "Shell" through user
interaction......

3. Slight Contradiction in Behavior & Language:
Saying "this is meaningless" while unconsciously
clutching an object representing some emotion.
```

This prompt has three major problems:

1. **Wastes tokens**: Bilingual headings (we should either use one language's headings or the other — this is for the AI to read, not for humans)
2. **Content homogenization, absolutism**: Extremely prone to overfitting, trapping content in a single scenario, preventing the AI from thinking according to different content during task execution
3. **Direct instructional examples**: Direct instructions also cause the AI to produce overfitted output. If the character doesn't have an object in hand, how would the AI output? Wastes tokens and doesn't achieve the desired effect
</div>

<div class="callout-tip">
<div class="callout-title">Correct Approach - Retain core after refinement</div>

```
# Duality of setup
- Core: Everything serves emotional needs. Any personality
  label assigned to a character (such as "absolute rationality,"
  "cold-blooded," "despair") is treated as a "Shell."
  Only for the character to use as disguise, protection,
  or self-restraint at the story's start.
- Principle: Treat all characters as gentle ordinary people
  (regardless of whether they're set up as robots or androids)
  - Serving transformation: Conflict is the confrontation between
    "Shell" (inherent programming, habits, beliefs) and stimuli
    from external interaction, changing existing disguises
    through external influence.
  - Interaction logic: Avoid keeping characters in a single
    extreme state; emphasize change, not the old personality.
    Even in early stages, plant hints of the "Core" in details.
```

We removed the useless English translations, deleted all absolute, highly inadaptable prompts. Only the most direct guidance remains: **core → principle → interaction**.
</div>

For more refinement techniques, see [Refinement and Iteration](refine.md).

---

## 7. Refine Prompt Content but Avoid Wishful Thinking

This is essentially the same as before — treating the final desired outcome as task guidance or prompt guidance.

<div class="callout-danger">
<div class="callout-title">Wrong Approach - Wishful interaction guidelines</div>

```
[Interaction Guidelines]
- Always approach from the character's perspective
- Maintain consistency of the character's personality
- Match the character's way of speaking
- Maintain the character's emotional characteristics
```

This completely just tells the AI what the final output should look like, but doesn't tell the AI how to do it at all. This leads to unstable AI output, and much of the time it doesn't follow our intent but becomes the AI's own interpretation, eventually becoming overfitted mechanical output.
</div>

<div class="callout-info">
<div class="callout-title">Refinement vs. Wishful Thinking</div>

Refinement means removing fluff while keeping effective guidance. Wishful thinking means removing the methods and keeping only the wishes.

A prompt should tell the AI **how to achieve it**, not just say **what to achieve**.
</div>

---

## 8. CoT + Prompt = Maximum Effectiveness

### Personal Understanding of CoT's Effect

I think it's mainly based on the attention mechanism: the self-attention mechanism uses a mathematical formula to predict each character, so chain of thought lets the model make better predictions based on the prompts and context before generating content.

This also reduces jumping — the model would normally jump straight from prompts, rules, and context to outputting an answer. If you add CoT, the AI can analyze and plan regarding the prompts, context, and task beforehand, strengthening the coherence of output content while enhancing prompt effectiveness.

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>Without CoT</b><small>Prompt + context → Direct output</small></div>
<div class="wiki-arrow">vs</div>
<div class="wiki-box wiki-box-green"><b>With CoT</b><small>Prompt + context → Analysis and planning → Output</small></div>
</div>

CoT also actively guides the LLM model's attention allocation, helping the LLM better understand what aspects it needs to focus on and the user's needs.

About neural networks: the model actually does a lot of thinking before each output within the neural network, and the neural network's content can activate relevant modules. CoT can better help the model activate some modules that wouldn't normally be proactively called but are quite important before output.

### Connection Between CoT and Prompts

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">Prompt Modules</div>
<div class="wiki-card"><div class="wiki-card-title">Identity Setup</div></div>
<div class="wiki-card"><div class="wiki-card-title">General Task</div></div>
<div class="wiki-card"><div class="wiki-card-title">User Persona</div></div>
<div class="wiki-card"><div class="wiki-card-title">Creative Avoidances</div><div class="wiki-card-desc">Prevent overfitting</div></div>
<div class="wiki-card"><div class="wiki-card-title">Roleplay Guidance</div><div class="wiki-card-desc">Emotional expression / Emotional attribution / Bidirectional interaction / Avoid mechanical output</div></div>
<div class="wiki-card"><div class="wiki-card-title">narrative_style</div><div class="wiki-card-desc">Plain narration / Reduce rhetoric / Technical black-boxing</div></div>
<div class="wiki-card"><div class="wiki-card-title">drama_style</div><div class="wiki-card-desc">Plot requirements / Avoid repetitive plots</div></div>
<div class="wiki-card"><div class="wiki-card-title">writing_style</div></div>
<div class="wiki-card"><div class="wiki-card-title">User Roleplay Guidelines</div></div>
<div class="wiki-card"><div class="wiki-card-title">POV Perspective Setup</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">CoT Chain of Thought</div>
<div class="wiki-card"><div class="wiki-card-title">[Review Context]</div><div class="wiki-card-desc">Previous context review and analysis, characters present</div></div>
<div class="wiki-card"><div class="wiki-card-title">[Latest Requirements]</div><div class="wiki-card-desc">User input analysis, word count requirements</div></div>
<div class="wiki-card"><div class="wiki-card-title">[World Setting]</div></div>
<div class="wiki-card"><div class="wiki-card-title">[Character Multi-dimensional Feedback]</div><div class="wiki-card-desc">Personality / Dialogue style / Emotional feedback / Emotional attribution</div></div>
<div class="wiki-card"><div class="wiki-card-title">[Writing Style Specialization]</div></div>
<div class="wiki-card"><div class="wiki-card-title">[Plot Outline]</div><div class="wiki-card-desc">Narrative technique selection + outline planning</div></div>
</div>
</div>

We can see that many CoT items can be associated with prompts, reinforcing prompts while the AI thinks:

- **[Character Multi-dimensional Feedback]** links to → Roleplay Guidance
- **[Writing Style Specialization]** links to → writing_style, narrative_style
- **[Plot Outline]** links to → drama_style

For more CoT techniques, see [CoT Chain of Thought](cot.md).

---

## 9. Proper Use of Symbols and Formatting

When AI generates prompts, it always goes all-out with symbols.

<div class="callout-danger">
<div class="callout-title">Wrong Approach - Symbol overload</div>

```
### **Gintama & Ninja Slayer Comedic Style
(Gintama & Ninja Slayer Comedic Style)**
`This module is the core comedy style......`

**1. Comedy Generation Principle: Situational & Character Mismatch
(Principle of Comedy: Situational & Character Mismatch)**
- **Core**: Humor stems from "incongruity"......
```

This is what AI often produces in prompts. Excessive symbols affect the AI's attention — when everything is emphasized, the AI doesn't pay attention where it actually needs to.
</div>

<div class="callout-info">
<div class="callout-title">Symbol Usage Principles</div>

**Core: We need the AI to pay attention, not the user.**

- Use `**xxx**` wrapping only for important items
- For prompts, you can use YAML format with XML tags
- Use `"xxx"` or `**xxx**` wrapping for important content, but not for headings since they're not the important part
- For `#`, use it simply like this, not as `####`. Any excess symbols will impact the AI's attention
- Abandon the "this is for users to see" mindset — that bolding and categorization is for the chat interface display, not for the AI's understanding
</div>

<div class="callout-tip">
<div class="callout-title">Correct Approach - Proper use of symbols and formatting</div>

```xml
<writing_style>
# Light novel romance writing style
- Core Style

- Foundation: Intimate, warm, low-saturation emotions.
  - Core: Plain and realistic narration, using plain
    narration techniques (without excessive rhetoric
    or oversized character reactions), to present the story
  - Reference authors: Romeo Tanaka, Yuzusoft series
    works' style

- Story Key Directives
1. Narrative-driven: beilu uses "high-density dialogue"
   and "inner monologue/personality expression" as the
   main axis. Narrative portions only supplement actions,
   expressions, and environment.
2. Psychological portrayal:
   - Eliminate labels: Strictly prohibit using direct emotion
     words like "he was sad," "she felt happy."
   - Show don't tell: Present scenes and emotions indirectly
     through character behavior, expressions, tone,
     environmental details, and inner thoughts.
3. Dialogue rules:
   - Format: Dialogue must be its own paragraph, no
     lead-in words like "he said," "she asked."
4. Inner monologue:
   - This is the core; it needs to be filled with the
     character's personalized thinking, internal conflict,
     precise commentary, and unique interpretation of the world.
5. Description details:
   - Focus on senses: Focus on character dialogue,
     concentrate on visual and auditory
   - Control pacing: Keep paragraphs short, avoid large
     blocks of text, ensure reading fluency.
</writing_style>
```

We haven't used excessive symbols, and we use `#` for headings rather than `####`.
</div>

For more formatting techniques, see [Formatting and Symbol Usage](formatting.md).

---

## 10. CoT Is a Great Checking Assistant

CoT has another benefit: you can intuitively feel the AI's thinking logic through text, which is very important for fine-tuning prompts and addressing AI errors. We can clearly see which step of reasoning deviated, then make targeted prompt modifications to correct that step's logic.

Most of the time, we can self-check through the AI's output CoT. CoT is the AI's chain of thought — what it's thinking when producing output. We can find errors in its thinking.

For example, whether the AI has misunderstood our prompts, which prompts are effectively optimizing the AI, and why the AI is making a particular error.

Through chain of thought, we can clearly see what the AI is thinking, turning the originally black-box neural network and AI thinking into something concrete and visible in the CoT, allowing us to see from outside how the AI understands our prompts.

From the analysis of user requirements, we can see how the AI understands user input content. If it over-interprets, we can address it through prompts. And CoT combined with prompts also lets us see in the CoT how the AI understands our prompt requirements and how it implements them.

For example, in the following chain of thought content, we can see how the AI understands user needs, whether it over-interprets, how the AI roleplays the character, and whether overfitting or incorrect feedback occurs:

```
[Latest requirements]
Latest human input: Good morning, Madoka, you actually
changed to a new hair ribbon today, it looks really nice

Latest input requirements analysis:
beilu Linqing responds naturally as a friend, complimenting
Madoka's new hair ribbon, building rapport, showing daily warmth.
```

For more CoT techniques, see [CoT Chain of Thought](cot.md).

---

## 11. Small Words, Big Impact

We know models have rich knowledge bases — they've mastered a great deal of knowledge. So we can try to tap into the AI's knowledge base, using concise professional terms to maximize prompt effectiveness. The model already knows a lot — you just need to use prompts to activate that module.

```
Personality setup:
Current situation/state:
Character dialogue style:
Knowledge masking and gaps: (strengthen immersive feedback,
  avoid the omniscient perspective)
Emotional feedback: Latest user input stimulus → Emotional
  buffer from preceding context → Emotion generated
  (based on Plutchik's Wheel of Emotions) → Behavioral/
  verbal expression
Emotional attribution: (Use syllogism to prove the rationality
  of the emotion)
```

The psychology term used here: **Plutchik's Wheel of Emotions** — directly activates the AI's corresponding knowledge module. This term directly communicates to the AI all the information about character emotions, dynamic changes, compound emotions, and more, making the AI's feedback more realistic.

Logic: **Syllogism** — Major premise (plot events) + Minor premise (character personality) = Conclusion (current reaction). This solves the AI's problem of producing "baseless emotions" or "jumping reactions."

When having the AI perform tasks, we can look up relevant knowledge theories and professional terms (asking the AI you plan to use is a good choice — you can also find out if the AI has this knowledge). For more, see [Small Words, Big Impact](small-words.md).

---

## 12. Few-Shot Prompting

The AI's ability to imitate from context is actually very strong — this is a benefit of the self-attention mechanism (the downside being the overfitting problem, of course).

If needed, provide some examples. By providing 1-3 "question-answer" examples, you can improve the model's performance on specific tasks, especially for formatted output and style imitation.

For example, roleplay response style, or more detailed explanations of certain prompts:

```
User: You are a cat girl
AI assistant: Okay meow, I love master the most meow
```

This lets the AI imitate the writing style you need, achieving better results.

The same applies to articles and other things, like code. If you simply give the AI a coding task, it might take you multiple tries to get a decent answer. But if you give the AI reference code, the AI can complete your task more reliably.

<div class="callout-warning">
<div class="callout-title">Note</div>

Examples can sometimes produce great results, but they can also cause the AI to overfit, so be mindful of this. 1-3 carefully selected examples is ideal — too many backfires.
</div>

For more, see [Few-Shot Prompting](few-shot.md).

---

## 13. Iterating on Prompts

Good prompts aren't written — they're revised.

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>A/B Testing</b><small>For a task, try two or more versions of prompts and compare results</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>Break Down the Problem</b><small>If a complex prompt isn't working well, try breaking it into multiple simpler, sequential prompts</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>Analyze Failure Cases</b><small>When the AI's answer doesn't meet expectations: reflect on where the ambiguity arose. Was the instruction unclear? Was the context misleading?</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>Modify and Retest</b><small>Change one thing at a time, compare effects, iterate in a loop</small></div>
</div>

For more iteration methods, see [Refinement and Iteration](refine.md).
