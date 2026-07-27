# Getting Started with Prompts

Author: beilu Linqing (dc@ciallo_beilu)

Licensed under CC BY-NC-SA 4.0

References:
- https://www.promptingguide.ai/zh (Highly recommended)
- https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide
- https://ai.google.dev/gemini-api/docs/prompting-strategies?hl=zh-cn
- https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview
- https://api-docs.deepseek.com/prompt-library
- https://bigmodel.cn/dev/howuse/prompt

---

## Introduction to Prompts

Through simple prompts, we can get results from LLM large language models, but the quality of results depends on the amount and completeness of information you provide.

> This section originally contained an illustration: [A simple prompt input example]

> This section originally contained an illustration: [A detailed prompt input example]

A prompt can include instructions or questions you pass to the model, as well as other details like context, input, or examples. You can use these elements to better guide the model and thus get better results.

### The Purpose of Writing Prompts

To make the AI achieve our expected goals.

So: **Clarify your requirements, clarify what you want the model to do.**

### Common Beginner Mistakes

- **Overly bloated prompts**, thinking more rules are always better: Prompts aren't better with more words or more forced rules — they need more guidance
- **Internal contradictions in prompts** (e.g., "be brief" but "give detailed examples")
- **Ignoring the model's own weaknesses and strengths**, such as: attention, writing style, overfitting

---

## Understanding LLM Large Language Models

### Understanding Parameters

Beyond prompt processing, the first thing we should master about large language models is the various parameters.

| Parameter | Function | Usage Suggestions |
|------|------|---------|
| **Temperature** | Higher temperature means more randomness, more likely to output lower-probability content | Raise for creative tasks, lower for factual tasks |
| **Top_p** | Controls output content diversity | Lower for precise answers, higher for diverse responses |
| **Frequency penalty** | Suppresses high-frequency repeated words | Not applicable to some models |
| **Presence penalty** | Suppresses words that have already appeared (even if only once) | Use when reducing repetition |

You can also check the official documentation for: maximum context length, recommended temperature (though in practice it's not always great), areas of strength, official prompt writing tips, etc.

In beilu, these parameters can be adjusted in the [AI Service Source parameter settings](../ai-service/model-params.md).

### Understanding Model Strengths and Weaknesses

Knowing each model's characteristics (what it's good at and what it's not) and common issues makes it easier to write prompts (so don't expect one prompt to work for all models — practice trumps everything).

> This section originally contained an illustration: [Comparison table of different models' capabilities in AI roleplay]

### Common Model Weaknesses

1. **Hallucination**: Making up content about certain topics (adding nonexistent settings in roleplay, or giving you knowledge that doesn't exist)

2. **Overfitting**: Especially in writing, tends to produce "AI-flavored" output, using lots of professional, complex vocabulary, and frequently using the same descriptive technique or vocabulary

3. **Knowledge issues**:
   - **Knowledge vagueness**: The AI's knowledge comes from compressed internet knowledge, so the content is not completely accurate. Its knowledge output also relies entirely on the attention mechanism to guess
   - **Knowledge staleness**: Information becomes outdated because it cannot be properly updated

---

## The Nature of Conversation (Optional Reading)

<div class="callout-info">
<div class="callout-title">Optional Content</div>
The following sections on conversation nature and attention mechanism are relatively advanced knowledge points. You can read them optionally.
</div>

### LLM Processing Flow

<div class="wiki-flow">
  <div class="wiki-box wiki-box-amber wiki-box-full"><b>Input Content</b></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>Tokens</b><small>Text split into tokens</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>Vector Conversion</b><small>Tokens mapped to mathematical vectors</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple wiki-box-full"><b>Neural Network (Self-Attention)</b><small>Computing context associations</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>Decoding</b><small>Sampling from probability distributions</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>Guessing content (influenced by parameters) → Output</b></div>
</div>

### How a Conversation Works for the AI

New conversation → Convert its knowledge and user input into tokens → Create a compressed package that continuously expands through dialogue

LLMs do not have traditional memory capabilities. When generating each reply, they process the current question along with all previous dialogue history (within the context window) as entirely new input. It's like having to re-read the entire conversation record each time you chat. So the longer the context, the greater the burden on the LLM (neural network, attention, etc.).

<div class="callout-tip">
<div class="callout-title">Tip</div>
Generally speaking, keeping context tokens at about half of the officially specified maximum context is optimal, and will give the LLM model better attention and output quality.
</div>

Essentially, you're having a conversation with a compressed package of internet data.

### Attention Mechanism

To understand why LLM large language models know what we want to express and how they know what answer we need, we need to start with the neural network's attention mechanism.

Dynamic attention to user input text content (meaning it judges which characters are more important and represent the main point).

For example, this sentence:

```
You will roleplay as a cute cat girl, using a cute tone to chat with me
```

#### Key Components

| Component | Function | Analogy |
|------|------|------|
| **Query** | What the model currently "wants to ask" | "What does the user want me to roleplay?" |
| **Key** | "Labels" for the input text | "cat girl" "chat" |
| **Value** | The actual response content | "Meow~" |

Imagine you're in a library writing a paper on "AI ethics" (Query). The library has thousands of books, each with a label (Key), like "machine learning," "philosophy," "sociology." The attention mechanism is like an efficient librarian that judges which book labels (Keys) are most relevant to your paper topic (Query), then hands you the most relevant book contents (Value) for reference. Each word in your input text is both a Query and potentially a Key.

> For deeper understanding, see this paper: https://arxiv.org/abs/1706.03762

### Model Attention on Context: U-shaped Structure

The model's attention generally follows a U-shaped structure, which in academic terms is known as **Lost in the Middle**.

LLM model attention on context is actually uneven. Models tend to focus most on the beginning and end of the context, while information placed in the middle has a higher risk of being overlooked or forgotten.

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">Head (high attention)</span>
Identity, general task, important rules
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">Middle (low attention)</span>
Long settings, conversation history
</div>
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">Tail (high attention)</span>
Prompts for mitigating model issues, guidance for the current task, chain of thought, some additional features
</div>
</div>

#### Why This Happens

- **Positional Encoding limitations**: The Transformer architecture doesn't inherently understand order; it uses "positional encodings" to tell the model each token's position in the sequence. In context, positional information at the beginning and end is unique and clear

- **Training data bias**: The LLM's training data and methods reinforce this behavior. In many tasks, the most important information (like the question) does appear at the end, while background information appears at the beginning. The model learned this "both ends are important, middle is secondary" pattern during training

> A famous paper from Stanford, "Lost in the Middle: How Language Models Use Long Contexts," systematically verified this phenomenon through experiments.

For more on U-shaped attention in prompt applications, see [Prompt Fundamentals](theory.md).

---

## beilu's General Approach to Writing Prompts

### Determining Direction

Generally, I think through these when writing prompts:

1. What do I want the AI to do
2. What's the general direction (writing? fiction? code?)
3. My fairly specific plan and the general effect I want the AI to achieve

After thinking through these, I first determine the AI's identity. Such as: novelist, frontend code expert, in-depth news analyst, etc.

Then for the actual prompt writing part:

1. I write the general effect I want from the AI as a simple prompt
2. Then have the AI help me polish the prompt
3. Then make my own revisions to the AI's prompt

### Debugging

Check the AI's performance under the prompt — is it achieving the effect I want? Continuously debug and improve the prompt based on the AI's current behavior, adjusting for the AI's errors and areas that need improvement.

---

## A Decent Prompt

### The Core Four Elements (Golden Rule)

| Element | Description |
|------|------|
| **Role** | Give the AI an identity |
| **Task** | Tell the AI what to do |
| **Requirements** | Specific constraints and needs |
| **Examples** | Reference examples for the AI |

<div class="callout-warning">
<div class="callout-title">Note</div>
Using examples may cause overfitting, so be mindful of this.
</div>

### Prompt Writing Approach: Give the AI a Clear Framework

For example, if we want the AI to play a roleplay game with us, just having the AI play a cat girl might not produce great results. In everyday conversation, clear expression makes communication easier to understand.

So we can break down the task we want the AI to perform into modules:

```
Original version:
──────────
My task is xxx, I want you to do xxx, you need to do xxx

Modular version:
──────────
Current identity:
Task:
Requirements:
Specific requirements:
Examples:
```

This modular, specific approach lets the AI better execute your commands and tasks.

### Give the AI an Appropriate Identity and Setup

Currently in the prompt space, many people feel identity setup isn't very important. But in my personal experience from extensive testing, identity has a significant impact on the AI's output content.

Even a few words' difference can cause major changes in the AI's output. For example, if I want the AI to do roleplay, common identities are basically: interactive fiction author, novelist, light novel writer.

But I discovered one preset author using "**unconventional long-form novelist**." The use of "unconventional" is quite clever, because it suppresses the AI's overfitting (the "AI flavor") right at the identity setup level.

Another example: if I want the AI to help summarize an article to make it readable while still letting ordinary people understand the specialized terms. Then I would use two identities — **in-depth writing expert** and **commercial journal writer** — letting the AI create in-depth content while using the journal writer identity to optimize readability for general audiences (of course, there are also prompts later that specifically reinforce this aspect).

For more on identity setup techniques, see [Identity Setup Techniques](identity.md).

### Give the AI an Example: Few-Shot Prompting

The AI's ability to imitate from context is actually very strong — this is a benefit of the self-attention mechanism (the downside being the overfitting problem, of course).

If needed, provide some examples. By providing 1-3 "question-answer" examples, you can improve the model's performance on specific tasks, especially for formatted output and style imitation.

For example, roleplay response style, or more detailed explanations of certain prompts:

```
User: You are a cat girl
AI assistant: Okay meow, I love master the most meow
```

This lets the AI imitate the writing style you need, achieving better results. The same applies to articles and other things, like code. If you simply give the AI a coding task, it might take you multiple tries to get a decent answer, but if you give the AI reference code, the AI can complete your task more reliably.

<div class="callout-warning">
<div class="callout-title">Note</div>
Examples can sometimes produce great results, but they can also cause the AI to overfit, so be mindful of this.
</div>

For more on Few-Shot, see [Few-Shot Prompting](few-shot.md).

### The Overfitting Problem

When LLMs produce output, they tend to frequently output a particular word, use a particular rhetorical technique, or add an uplift at the end — this is overfitting.

This happens because our prompts and post-training SFT and RLHF data guide the AI in how to respond and create, meaning the AI imitates patterns in the dialogue data. When a pattern appears too frequently, the AI may prioritize outputting that content. This is the overfitting commonly seen in current AI creative tasks. Overfitting is often caused by too many examples leading the model to over-imitate local patterns rather than understanding the essence of the task, which is related to how the self-attention mechanism reinforces local patterns.

Much of the time when we write prompts, we should be working to reduce such occurrences from the LLM model.

---

## Prompt Formatting

Different models are sensitive to different formats. When writing Presets and Character Cards, you'll generally use these formats:

| Format | Common Use Cases | Example |
|------|---------|------|
| **XML** | Presets | `<description>xxx</description>` |
| **JSON** | Structured data | `{"role": "cat girl"}` |
| **YAML** | Character Cards | `name: cat girl` |
| **Code blocks** ` ``` ``` ` | Code, examples | Wrapping code snippets |

For content I want the model to pay special attention to, I'll use symbols like `""` or `**` to wrap it.

Of course, different models have different sensitivity (compliance priority) to tags and wrapping symbols. It's recommended to compare using different symbols under the same conditions — that is, through **A/B testing**.

### Character Card Example (YAML)

```yaml
name: Neko
personality: Tsundere and lively, loves fish snacks
speech_style: Ends sentences with "meow," uses kaomoji (≧▽≦)
```

### Preset Example (XML)

```xml
<role>Rigorous historian</role>
<rule>Responses must cite historical sources, refuse to fabricate content</rule>
<output_format>Point - Citation [source]</output_format>
```

Use more model-sensitive tags for more important content, and the more structured (rather than colloquial) the content, the better.

For more on formatting, see [Prompt Formatting](formatting.md).

---

## About Prompt Roles

When using more professional software, you'll find role options in prompt entries.

> This section originally contained an illustration: [Screenshot of role options in prompt entries]

They are:

| Role | API Parameter | Description |
|------|---------|------|
| **System** | `role: 'system'` | Prompt instructions provided as the system, mainly used to set a persistent, high-level instruction set for the AI. Weight is similar to user instructions, but when user instructions are stronger and use high-weight formatting, system prompt effectiveness may not exceed user prompt effectiveness |
| **User** | `role: 'user'` | Prompt content sent as the user, i.e., what the user says. In multi-turn conversations, past user messages are part of the history along with assistant messages, helping the AI understand the current context |
| **AI Assistant** | `role: 'assistant'` | Prompt content sent as the AI. Specific uses include imitating the AI's voice to strengthen prompt effectiveness, or blocking the native chain of thought |

---

## Give the AI Some Time to Think

When I use AI for coding, I first give it a specific, simple task. When it gives me roughly the result I want, I then have it use that code to tackle a harder task.

If you have the AI do all the code at once, it can result in errors everywhere.

Just like humans — when we do something, we first need to understand what task we're doing, then make a plan for the task. For instance, what do we do first, what's most important in this task, how do we complete it step by step. This can actually be applied to AI usage too.

### Example: Approach to Writing Roleplay Prompts

First I think about how novels are written. You know the three elements of fiction (character, setting, plot), right?

If I want the AI to write a novel, I would have it think about these things first, then execute the task:

1. **Previous context**: What happened before
2. **World setting**: What's the current world setting
3. **Character**: How should I roleplay this character
4. **Writing style**: What writing style do I need for creation
5. **Current plot**: Following the user's direction, what plot content do I need to write
6. **Plot design**: What plot do I need to design, what's the main content, what are the conflict points

Of course, this is also the approach I used to use when writing novels, but the AI's output quality actually improves a lot when it thinks through these steps.

This brings us to a commonly used prompt technique —

---

## Advanced Thinking Techniques

### Chain of Thought (CoT)

Chain of Thought: Having the model do a general analysis before responding.

Chain of thought in principle allows the model to break down multi-step problems into intermediate steps, meaning additional questions can be allocated to problems requiring more reasoning steps. Chain of thought provides an interpretable window into model behavior, intuitively showing how the model arrived at a particular answer, and providing opportunities to debug where the reasoning path went wrong.

<div class="callout-info">
<div class="callout-title">Drawback</div>
Chain of Thought (CoT) is linear. For more complex problems requiring weighing and exploration, non-linear reasoning structures are needed.
</div>

> Reference paper: https://ar5iv.labs.arxiv.org/html/2201.11903?_immersive_translate_auto_translate=1

#### Personal Experience with CoT

- An overly rigid chain of thought prevents the AI from adapting well to a broad range of situations
- An overly free chain of thought can't leverage prompt effectiveness
- Chain of thought content can be combined with prompts

#### Personal Understanding of CoT's Effect

I think it's mainly based on the attention mechanism: the self-attention mechanism uses a mathematical formula to predict each character, so chain of thought lets the model make better predictions based on the prompts and context before generating content.

This also reduces jumping — meaning the model would normally jump straight from prompts, rules, and context to outputting an answer. If you add CoT, the AI can analyze and plan regarding the prompts, context, and task beforehand, strengthening the coherence of output content while enhancing prompt effectiveness.

CoT also actively guides the LLM model's attention allocation, helping the LLM better understand what aspects it needs to focus on, and the user's needs and questions.

<div class="wiki-flow">
  <div class="wiki-box wiki-box-amber wiki-box-full"><b>Without CoT</b><small>Prompt + context → Jump straight to output</small></div>
  <div class="wiki-arrow">VS</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>With CoT</b><small>Prompt + context → Analysis and planning → Output</small></div>
</div>

About neural networks: the model actually does a lot of thinking before each output, within the neural network, and the neural network's content can activate relevant modules. CoT can better help the model activate some modules that wouldn't normally be proactively called but are quite important before output.

CoT has another benefit: you can intuitively feel the AI's thinking logic through the text, which is very important for fine-tuning prompts and addressing AI errors — we can clearly see which step of reasoning deviated, then make targeted prompt modifications to correct that step's logic.

Combining with prompts: CoT can also combine specific thinking items with prompts for specific task requirements, achieving better prompt effectiveness.

For more on CoT, see [CoT Chain of Thought](cot.md).

### Skeleton of Thought (SoT)

The skeleton prompt template is designed to guide LLMs to output a concise skeleton of the answer. Then, we extract the key points from the LLM's skeleton response.

This can be understood as having the AI create a thinking framework for the task, then flesh out the details within the framework:

1. **Step 1 - Generate skeleton**: "For [your task], please first list an outline (skeleton) of the core steps/key points for solving this problem, without expanding on details."
2. **Step 2 - Parallel expansion**: After getting the skeleton, send new requests: "Now, please elaborate on point [N]: [content of point N from the skeleton]"

This is very suitable for generating structured long-form content (reports, articles, etc.).

> Reference paper: https://arxiv.org/html/2307.15337v3#S2

### Algorithm of Thoughts (AoT)

Tree of Thoughts (ToT) and Algorithm of Thoughts are similar in that both expand tasks from multiple perspectives to find the optimal solution path.

The focus is on a class of tasks similar to tree search problems. These tasks require decomposing the main problem, designing feasible solutions for each subdivision, and deciding whether to continue or abandon, while also being able to re-evaluate more promising subdivisions. Rather than querying each subset individually, we leverage the LLM's iterative capabilities to solve these problems in a single unified generation sweep.

Core elements: **Variable definition (problem), decision process, evaluation criteria**

> Reference paper: https://arxiv.org/html/2308.10379v3#S3

### Meta-Prompt

The meta-prompt approach enhances language model utility by providing a broad, flexible framework without sacrificing specificity or relevance. This makes the technique's application more dynamic and comprehensive, further expanding its potential to effectively handle various tasks and queries.

> Reference paper: https://arxiv.org/html/2401.12954?_immersive_translate_auto_translate=1

---

## beilu's Prompt Tips

### Small Words, Big Impact

We know models have rich knowledge bases — they've mastered a great deal of knowledge.

So we can try to tap into the AI's knowledge base, using concise professional terms to maximize prompt effectiveness. The model already knows a lot of things — you just need to use prompts to activate that module.

For example: terms like **three elements of fiction** and **Plutchik's Wheel of Emotions**. The AI can understand them; there's absolutely no need to use many words to express it — just use the relevant terminology and the AI will understand your needs.

So how do I determine whether the AI knows a particular piece of knowledge?

Simple — just ask the AI directly. If the AI's answer mostly aligns with that knowledge, then the AI's knowledge base includes it. Just remember to turn off web search.

For more on small word techniques, see [Small Words, Big Impact](small-words.md).

### Prompt Guidance

Sometimes we can think of the AI as a stubborn person — you'll find that the AI always likes to find loopholes in your prohibitions, always believing it's right. In this case, we can change our approach:

**Positive guidance is better than negative prohibition** (Positive Prompting > Negative Prompting): Sometimes the effectiveness of a prohibition is not as good as "you can do it this way," or as the saying goes, channeling is better than blocking. We can give the AI alternative guidance and approaches to meet our needs on certain issues.

**Strict commands**: Sometimes we also need strict commands to help the AI better complete our tasks, for example: must output in English. But for vague content (like "don't output metaphors like a stone thrown into a lake"), the AI won't follow very well.

For more on guidance techniques, see [Guide Rather Than Ban](guide-not-ban.md).

### Local Optimum Can Sometimes Beat Global Optimum

In complex tasks, stage-by-stage optimization (such as planning first, then generating) may more easily achieve reliable results than a single global prompt, because LLM reasoning ability is limited by context length.

Optimize through the best approach for the current task, guiding the AI with a non-fixed chain of thought to generate replies.

For example: when completing a roleplay task, I optimize the current task using a writing-based approach. Achieving the local optimum for this problem — that is, local optimum rather than global optimum — to optimize AI performance in a single direction (such as: roleplay, writing, problem-solving, code).

### Staged Tasks

We can have the AI complete a task across multiple conversations rather than in a single task. For example: coding tasks, design tasks, fiction writing.

For example, if we want the AI to help us translate an article and write a simple report, we can break the task into several stages:

1. Translation
2. Optimization and reordering of the article
3. AI post-processing for style optimization

Design different prompts for each, breaking the task into different stages. That is, 3 conversations, progressing through the task incrementally across the three conversations.

### Prompt Iteration

- **A/B testing**: For a task, try two or more versions of prompts and compare results
- **Break down problems**: If a complex prompt isn't working well, try breaking it into multiple simpler, sequential prompts
- **Analyze failure cases**: When the AI's answer doesn't meet expectations, reflect on where the ambiguity arose. Was the instruction unclear? Was the context misleading?

For more on prompt iteration, see [Prompt Iteration](refine.md).
