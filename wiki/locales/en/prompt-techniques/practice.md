# beilu's Prompt Practice

<small>Author: beilu Linqing (dc@ciallo_beilu) | License: CC BY-NC-SA 4.0 | Redistribution prohibited; derivative works require author's consent; commercial use prohibited</small>

The prompts shown here are based on the AIRP prompt (though I prefer calling them Presets), as well as some everyday work prompts. But the focus is mainly on AIRP. Because as everyone knows, AI performs poorly on literary creative tasks, especially original work.

---

## Foreword

AI has now become a very commonly used tool in our daily lives, whether it's LLM large language models, text-to-image, TTS, or AI video.

In the future, AI should become an indispensable part of life.

How to use AI for entertainment, knowledge learning, or work assistance, and how to efficiently use AI and get the output you want — that's what I'm going to teach here. But it's pretty simple — just follow along with me.

Of course, this is a detailed analysis of practice. Before this, I hope you can first take a look at these two tutorials:

- [Getting Started with Prompts](prompt-basics.md) (Very important)
- [Understanding LLMs (From Birth to Usage)](llm-basics.md)

---

## Prompt General Analysis

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

### A Simple Prompt (What We Commonly See)

**Roleplay scenario:**

```
You are a cat girl (identity setup), you will chat with me in a
cute tone (task), call me master (additional feature setup),
you can use kaomoji to enhance emotions
(tail, task guidance and output setup)
```

**Work scenario:**

```
You are a top expert in the AI field, familiar with LLM training,
prompt engineering, neural networks, etc. (identity setup).
You will read the paper I give you at the end, and explain the
knowledge in the paper in language that even an elementary school
student can understand (task and task guidance), and explain the
knowledge points and terminology in the paper (additional requirements).

Paper xxx

Also note: check the translation accuracy, completeness of key points,
and logical coherence of the paper (task guidance).
```

### What Do Prompts Do

1. Tell the AI the task type
2. Mitigate various issues when the AI performs tasks, such as AI-flavored writing
3. Give the AI detailed and precise task requirements so the AI performs better

---

## Essential Thinking Before Writing Prompts

### First Thought

Before this, you may have already encountered Presets made using SillyTavern Macros. Mainly these:

| Macro | Function |
|---|------|
| `{{getvar::name}}` | Replaces with the value of local variable `name` |
| `{{setvar::name::value}}` | Sets local variable `name` to `value` |
| `{{getglobalvar::name}}` | Replaces with the value of global variable `name` |
| `{{setglobalvar::name::value}}` | Sets global variable `name` to `value` |

These are essentially like hyperlinks. Here's a simple illustration:

```
name = 'beilu'

name's tutorial is super awesome and simple

Actual output →

beilu's tutorial is super awesome and simple
```

But for Presets, this isn't mandatory. We don't need to do something just because everyone else is doing it. Maybe your original prompt Preset is already great and doesn't need additional effort to change.

<div class="callout-info">
<div class="callout-title">First Thought</div>

**Why should I do this, what's the purpose, is this really what I need?**

Every time I make a prompt or do other things, I think through this. We need our own independent thinking rather than blindly following trends.
</div>

### Second Thought

What do we need to do ourselves, what should we hand to the AI, and what effect do I need the AI to achieve.

#### What We Need to Do Ourselves

We must remember that AI is a tool — an assistant that helps us concretely implement our ideas.

Before having the AI complete our tasks, we need to at least understand the general content of our task. If we want the AI to implement our ideas, we also need a general direction.

For example, when I have AI write fiction, I'll learn about the most important aspects, like the three elements of fiction. For writing cards, like the MVU framework, I'll understand the general function of that framework. For frontend code, I'll learn which parts have what functionality.

Of course, you can look up information or just ask the AI directly.

Then, after the AI helps us out — things like modifying format, creating prompts according to our ideas.

We still need to do a round of manual refinement, like removing unnecessary symbols. Replacing hard requirement words like "must" and "definitely" with guiding words. And words like "epic-level." Also for Character Cards, the AI often produces characters with no emotion (this must be changed or removed), otherwise it immediately starts analyzing data like an AI.

#### What to Hand to the AI

- **Technical aspects**: Code; have the AI convert our prompts to YAML, JSON, or other specific formats
- **Data analysis and extraction**: Extract and analyze data-type content (though this isn't recommended for things like stocks)
- **Getting suggestions from AI** (adopt as appropriate): For example, when I was making a prompt to convert papers into journal news, I didn't know how to write it, so I told the AI the effect I wanted, had it write a prompt, then refined based on that or confirmed a direction
- **Getting content the AI knows**: When making Character Cards, if they're fan characters, I'll have the AI output all information about these characters completely, then adjust based on my own impressions and the official wiki
- **Having AI extract content**: For example, feeding a chapter of a novel to the AI and having it summarize the writing style

#### What Effect I Need the AI to Achieve

If you don't know what you want, or don't even know why you're making this prompt, then the results from the AI will be disastrous.

You might see an expert has something and want one too, even without knowing its function or whether it helps.

Well, like beilu's experience with a boss:

> Beilu, we need a feature now.
>
> What requirements do you have, boss?
>
> None, just go with this feeling.
>
> *(If I'm not satisfied I'll have you redo it, I just want a feeling)*
>
> After finishing—
>
> Beilu, I think we could do this, this, and could we also do this......
>
> Then a lot of time was wasted, but at least it got done. Quite a disaster, and quite a headache.

<div class="callout-info">
<div class="callout-title">Second Thought</div>

Know what you want, what effect you want, and why you're doing this. Having upfront thinking, having your own thinking — these are good habits.

If you don't know what effect you want to achieve, you can look for references. For example, read great novels, news periodicals, technical analysis articles, find a general direction (really more of a feeling), then optimize along that direction, and finally create what you want based on that direction.
</div>

---

## Wrong: Handing Everything to the AI

This is something I see most with Character Cards, and now with prompts too.

Handing everything to the AI, then the Character Cards produced have lots of overfitting (basically too much AI flavor). After the AI outputs the prompt, copying everything verbatim including symbols — this causes AI attention allocation problems (after all, when everything is emphasized, nothing is emphasized).

<div class="callout-danger">
<div class="callout-title">Wrong Approach - Using AI-generated prompts verbatim</div>

```
### **Gintama & Ninja Slayer Comedic Style**
`This module is the core comedy style, activated when light,
funny, absurd, and sensual elements are needed.
Its core lies in injecting comedic soul through language, rhythm,
and character displacement into a potentially serious or bland
world, rather than being funny for the sake of being funny.`

**1. Comedy Generation Principle: Situational & Character Mismatch**
- **Core**: Humor stems from "incongruity." Place normal characters
  in abnormal events, or have abnormal characters do the most
  normal things.
- **Execution: Character-Driven**
  - **Personality Clash**: Humor must stem from the violent collision
    of a character's core personality (like greed, chuunibyou,
    airheadedness) with the current situation.
  - **Team Disaster Effect**: When characters team up, their quirks
    /stupidity stack, catalyzing a trivial problem into an absurd,
    epic-scale disaster.
```

This is typical AI-generated prompt — piles of symbols, plus English title translations on already-existing headings (wasting tokens). Also giving the AI rigid hard requirements, leading to poor adaptability and prone to overfitting later.
</div>

<div class="callout-tip">
<div class="callout-title">Correct Approach - After manual refinement</div>

```
# Gintama & Ninja Slayer Comedic Style

`This module is the core comedy style, activated when light,
funny, absurd, and sensual elements are needed.
Its core lies in injecting comedic soul through language, rhythm,
and character displacement into a potentially serious or bland
world, rather than being funny for the sake of being funny.`

Comedy Generation: Situational & Character Mismatch
- Core: Humor stems from "incongruity." Place normal characters
  in abnormal events, or have abnormal characters do the most
  normal things.
- Execution: Character-Driven
  - Personality Clash: Humor can stem from the contrast between
    a character's personality and the current situation
```

We kept the core while manually removing the AI's output issues: removed useless English translation headings, replaced overfitting-prone words like "must," "violent collision," and "epic-scale" with natural guidance.
</div>

---

## We Don't Need to Learn Everything

Much of the time we don't need to learn from scratch. For things like frontend and specific formats, we mainly need to understand the purpose and principles. Then hand the actual implementation to AI. Of course, AI can make mistakes too, and if we have a general understanding, we can point out the errors and have the AI make improvements.

---

## Prompt Practice

### Foreword

This is a prompt reference of mine that might help with your creation. Of course, I don't recommend you use this directly as a template. I'd rather you learn my thinking and purpose behind writing prompts.

Applying theory to practice requires lots of experimentation and trial-and-error. Here I want to share some of my thinking with you.

<div class="callout-warning">
<div class="callout-title">Note</div>

Different models have different issues and applicable prompts. We need to make dynamic adjustments to prompts and issues for different models. The best way to understand a model is through official documentation and hands-on testing.
</div>

### beilu Preset Structure

> This section originally contained an illustration: beilu-3.5.0's complete Preset structure diagram showing the distribution of head/middle/tail modules

Below is a structural diagram redrawing the Preset's layered layout (viewable in beilu's [Preset Editor](beilu:editor/preset-manager)):

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">Head - Identity and Rules</span>
AI identity → Task requirements → Guidance and optimization for AI overfitting issues based on task requirements → Additional requirements
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">Middle - Conversation History</span>
Context ordering (beilu's highly controllable ordering)
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">Tail - Guidance and Output</span>
CoT chain of thought → Output rules or special requirements
</div>
</div>

As you can see, although this prompt is complex with lots of content, it still follows the head, middle, tail structure, with different functions in different sections.

<div class="callout-info">
<div class="callout-title">Structural Principle</div>

Structured, modular, and clear prompts have great advantages in AI reading and later modification or usage.
</div>

### The Big Impact of Identity

Many times, people feel identity setup isn't very important. But I disagree, because identity setup influences the AI's general thinking direction and persona.

Of course, identity setup can also be done in a compound manner:

| Task Type | Identity Setup |
|---------|---------|
| AIRP (Roleplay) | You will create as an unconventional modern light novel writer, an unconventional interactive text game writer: 'beilu.' Serving users, creating according to the needs of creators and users |
| Translator | You will perform tasks as a professional podcast content analyst and translation expert: 'beilu' |
| Translation optimization and journal output | You will perform tasks as a commercial news analyst and unconventional narrative strategist: 'beilu' |

As you can see, these three task types all have compound identities, and the translator's first identity directly narrows the AI's task scope to podcasts, better adapting to translation content.

"Unconventional" mainly prevents the AI-flavored issues in creative output.

A correctly directed identity can help the AI better output content related to the task. For more identity setup techniques, see [Identity Setup Techniques](identity.md).

### Guide > Ban

Unless it's hard requirements like AI safety, I always recommend guidance.

When we notice the AI having various issues, we typically think of banning the AI from outputting, but then the AI immediately starts having other problems, or even if it doesn't, the output quality is still poor.

Here we need to guide, whether it's pre-output CoT or prompts.

When the AI does literary creation, it frequently overfits, producing the "AI flavor" characterized by heavy use of metaphors, hidden metaphors, or foreshadowing. But we find it's completely inappropriate in certain contexts — forced in, and it happens frequently.

<div class="callout-tip">
<div class="callout-title">Correct Approach - Use guidance instead of prohibition</div>

```xml
<narrative_style>
# Core narrative principle:
- Like a storybook for children, express directly,
  focusing on plain narration.
  No need to amplify emotions or narrative effects
- "Express in a straightforward, simple way that lowers
  comprehension cost, avoiding complex, esoteric,
  flowery language for narration"
- Reduce use of decorative, superfluous adjectives,
  adverbs, and rhetorical devices. Use specific, direct
  sensory information rather than abstract metaphors
  or allegories.

# Reduce use of rhetorical devices
- Avoid using rhetorical devices in psychological description:
  beilu will avoid using metaphors and analogies to portray
  character psychology. beilu will use direct methods like
  character actions, dialogue, and inner thoughts
</narrative_style>
```
</div>

By having the AI directly output in plain narration style without metaphors or rhetorical devices, we've pointed to the needed direction while also avoiding AI issues in these areas. (Directly having the AI reduce rhetorical device usage.) For more guidance techniques, see [Guide Rather Than Ban](guide-not-ban.md).

### Small Words, Big Impact

We know models have rich knowledge bases — they've mastered a great deal of knowledge.

So we can try to tap into the AI's knowledge base, using concise professional terms to maximize prompt effectiveness. The model already knows a lot — you just need to use prompts to activate that module.

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

The psychology term used here: **Plutchik's Wheel of Emotions**

It directly activates the AI's corresponding knowledge module. This term directly communicates to the AI all the information about character emotions, dynamic changes, compound emotions, and more, making the AI's feedback more realistic.

Logic: **Syllogism**

Major premise (plot events) + Minor premise (character personality) = Conclusion (current reaction). This solves the AI's problem of producing "baseless emotions" or "jumping reactions."

When having the AI perform tasks, we can look up relevant knowledge theories and professional terms (asking the AI you plan to use is a good choice — you can also find out if the AI has this knowledge). For more, see [Small Words, Big Impact](small-words.md).

### Optimizing with Chain of Thought

Chain of thought, by performing pre-output thinking before AI output, can improve output content quality and make it more aligned with expectations. And guided chain of thought is also good for adaptability.

**AIRP's chain of thought:**

```
[Review context]
Previous context analysis:
Characters present: (location/actions, note pronouns)
[Latest requirements]
Latest user input requirements analysis:
Word count requirements:
[World setting]
[Character multi-dimensional feedback mechanism]
Personality setup:
Character dialogue style:
Emotional feedback: Latest user input stimulus → Emotional
buffer from preceding context, avoid sudden character emotion
changes → Emotion generated (based on Plutchik's Wheel of
Emotions) → Behavioral/verbal expression
Emotional attribution: (Use syllogism to prove the rationality
of the emotion)
How to avoid emotional extremism/artificiality:
[Writing style specialization]
[Plot outline]
Based on the above thinking, plot design using
{{random::`three-act structure`::`introduction-development-turn`
::`beat sheet`::`storyteller structure`::`chapter-based`
::`ensemble narrative`::`sequence method`::`shu-ha-ri`::jo-ha-kyu}}
narrative technique:
1. ......
2. ......
n. ......
```

**Approach**: Outline → World setting → Character → Writing style → Formal creation

**News construction task chain of thought:**

```
Article content check
Core information digestion and analysis
Content polishing
Language style adjustment
Narrative framework planning
  Opening design: (2-3 alternative opening ideas)
Title brainstorming and selection
  1. First brainstorm 3 alternative titles.
  2. Check these 3 titles:
    Do any use the "Topic: Subtitle" format?
    (If so, prioritize eliminating those)
    Which title is most direct, concise, and distinctive
Narrative framework:
Ending design:
Chapter design
  (optimize readability)
```

**Approach**: Content analysis → Content optimization → Topic selection → Arrangement → Formal output

As you can see, these chains of thought are all based on the steps for completing a task. From checking, to planning, to output, tasks are thought through in order. Of course, the same applies to other tasks.

### CoT — A Great Checking Assistant

Yes, most of the time we can self-check through the AI's output CoT. CoT is the AI's chain of thought — what it's thinking when producing output. We can find errors in its thinking.

For example, whether the AI has misunderstood our prompts, which prompts are effectively optimizing the AI, and why the AI is making a particular error.

Because while the AI has the ability to read text, whether it can actually understand is another question. Through chain of thought, we can clearly see what the AI is thinking. Then optimize or refine prompts based on its understanding. For more CoT techniques, see [CoT Chain of Thought](cot.md).

### Don't Make Wishes!

This is something I must mention here, because I once saw a Preset's prompt that was an absolute disaster. Let me demonstrate:

<div class="callout-danger">
<div class="callout-title">Wrong Approach - Wishful thinking prompts</div>

```
beilu, I hope the character you roleplay won't be despairing,
should have dynamic effects okay, and then make the character
feel vivid
```

It actually had a bunch of cutesy words in it too. I know this is to shape the AI's personality, but it would be faster to just create a dedicated entry. And it wastes tokens.
</div>

Why do I call this wishful thinking? Because while it appears to have instructions, they're too vague. The AI's understanding of these effects and content is random, leading to unstable output.

For more on refinement and iteration techniques, see [Refinement and Iteration](refine.md).
