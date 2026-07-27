# Understanding LLM Large Language Models

Author: beilu Linqing (dc@ciallo_beilu)

Licensed under CC BY-NC-SA 4.0

---

This tutorial takes you from zero to understanding how LLM large language models are created — from data collection and neural network training to finally becoming the "intelligent assistant" you use today.

## Phase One: Pre-training

### Packaging the Entire Internet: Downloading and Processing Internet Data

Why does AI know so much?

Because the knowledge base it learns from is enormously vast. One of the core sources is the Common Crawl project. This project continuously crawls and archives billions of web pages, forming a raw dataset at the TB (terabyte) or even PB (petabyte) scale.

That's because its knowledge base is essentially equivalent to all the text data on the entire internet, and much of it is high-quality documentation. This data covers knowledge from all domains.

> Hugging Face's fineweb-v1 dataset: https://huggingface.co/spaces/HuggingFaceFW/blogpost-fineweb-v1

Although there's a lot of data on the internet, if you count only high-quality text data, it's roughly around 44TB (storage unit).

### Data Collection

<div class="wiki-flow">
  <div class="wiki-box wiki-box-amber wiki-box-full"><b>Data Collection</b><small>Crawl massive raw data from the internet</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>Filtering</b><small>Remove low-quality and inappropriate content, prioritize high-quality sources</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>Text Extraction</b><small>Extract substantive content from HTML, filter out navbars, ads, etc.</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple wiki-box-full"><b>Deduplication</b><small>Strict deduplication to prevent the model from repeatedly learning the same information</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>Tokenization / Quantization</b><small>Convert text into tokens, represented by numeric IDs</small></div>
</div>

#### Filtering

Filtering: At the very first stage of data collection, large-scale filtering is needed. Low-quality content must be removed, such as:

- Malicious websites, phishing sites
- Large amounts of advertising and marketing content
- Adult or inappropriate content

At the same time, high-quality knowledge sources are prioritized, such as Wikipedia, code on GitHub, professional books, academic papers, etc.

> Wikipedia: https://zh.wikipedia.org/wiki/Wikipedia:%E9%A6%96%E9%A1%B5
>
> GitHub: https://github.com/

#### Text Extraction

Of course, this isn't just copy-paste — it involves directly crawling the raw HTML code (the code you see when pressing F12 on a web page), filtering unnecessary content like: navigation bars, advertisements, footers, and other irrelevant elements, to find quality substantive content.

At the same time, content is processed by language: for example, Gemini may have more English data, while DeepSeek may have more Chinese data. Less common languages are also filtered out, which is why AI capabilities in certain languages are relatively weaker.

#### Deduplication

The internet is full of duplicate or highly similar content (for example, the same news article reprinted by multiple outlets). To make the model learn more efficiently and from more diverse knowledge, strict deduplication is essential to ensure the model doesn't repeatedly learn the same information.

> This section originally contained an illustration: [Data deduplication process diagram]

### Tokenization / Text Quantization

LLMs cannot directly read the languages we commonly use. These languages need to be converted into tokens and represented by numeric IDs.

#### Tokenizer Principle (BPE Algorithm)

The mainstream algorithm today is BPE (Byte Pair Encoding). It converts text into short, unique byte sequences and creates new labels for commonly used content.

1. Initially, all individual characters/letters are placed in a base vocabulary, each corresponding to an ID. Even a symbol or a space corresponds to an ID; combinations create different IDs
2. Then, across the entire corpus, the most frequent adjacent pairs are found. For example, if "you" and "r" often appear together, they merge into a new token "your" with a new ID
3. This process repeats until the vocabulary reaches the target size (e.g., 50,000)

This approach can efficiently represent common words while also handling rare words never seen before (by breaking them into smaller units).

<div class="callout-tip">
<div class="callout-title">Try It Yourself</div>
You can visit https://tiktokenizer.vercel.app to intuitively experience tokenization in action.
</div>

> This section originally contained an illustration: [tiktokenizer interface screenshot showing text split into tokens]

## Neural Networks

Of course, we won't discuss training and formulas here — just the principles. A neural network can actually be thought of as similar to a human brain, though our brains are more complex (although my brain isn't as smart as AI — it's practically mush, heh).

<div class="callout-info">
<div class="callout-title">Recommended Resources</div>
Neural network visualization website: https://bbycroft.net/llm — lets you visually see the inner workings of neural networks.
</div>

> This section originally contained an illustration: [Neural network visualization interface screenshot]

### Inference: The Transformer Architecture

Neural networks use the Transformer architecture, whose core mechanism is called **self-attention**.

Put simply: predicting the next content based on context — essentially, guessing.

### Self-Attention

It allows the neural network, when predicting the next word, to "attend to" all previously appeared words (within its context window) and calculate each word's importance for predicting the next word (i.e., "attention weights").

> This section originally contained an illustration: [Transformer self-attention mechanism diagram]

#### How Attention Works

The self-attention mechanism uses a mathematical formula to predict each character. Transformer places all tokens on a "workbench." When it needs to generate the next word, the self-attention mechanism allows it to look back at previously existing content, and then better associate the next character.

Its formula is a massive expression formula that expands with each token:

```
P(w_t | w_<t) = softmax( LayerNorm( f_N( ... f_2( f_1( E[X] + PE ) ... ) ) * E^T ) )
```

> Note: The formula above is a heavily simplified version.

#### Dynamic Attention on User Input

The attention mechanism judges which characters in your input are more important. For example, in this sentence:

```
You will roleplay as a cute cat girl, using a cute tone to chat with me
```

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">High Attention</span>
roleplay, cat girl, cute, tone, chat — these are key semantic words with high attention weight
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">Medium Attention</span>
You, me — role relationship words providing context
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">Low Attention</span>
will, as, a, using, to, with — function words with low weight
</div>
</div>

#### Key Components: Query, Key, Value

| Component | Function | Analogy |
|------|------|------|
| **Query** | What the model currently "wants to ask" | "What does the user want me to roleplay?" |
| **Key** | "Labels" for the input text | "cat girl" "chat" |
| **Value** | The actual response content | "Meow~" |

Imagine you're in a library writing a paper on "AI ethics" (Query). The library has thousands of books, each with a label (Key), like "machine learning," "philosophy," "sociology." The attention mechanism is like an efficient librarian that judges which book labels (Keys) are most relevant to your paper topic (Query), then hands you the most relevant book contents (Value) for reference. Each word in your input text is both a Query and potentially a Key.

### Context Limitations

Through the association of each character token in context, the system calculates the content with the highest relevance for output (this also involves the attention mechanism in Transformer). For example, with the phrase "hello," the neural network has to filter through vast amounts of content to select the most relevant word. Naturally, the longer the context the neural network can process, the more computation is required.

Because the neural network needs to calculate associations for each character, the computational load is clearly enormous. This is why the main bottleneck limiting LLM development is hardware computational power.

### Context Imitation

LLMs actually have a very strong imitative response to context — which is easy to see through the attention mechanism. For instance, if you provide a writing style in the preceding text, the model will produce writing in a very similar style based on that preceding content. This is very useful both in using AI and in writing prompts for LLM models.

### Output Randomness

Because output is based on probability, the content produced each time will never be exactly the same.

### Output Result Inference

During the pre-training phase, the model's task is very simple: large-scale "fill in the blank." Massive amounts of text data are fed to it, the next word is masked, and it guesses. If it guesses correctly, it receives a "reward" (adjusting internal parameters to strengthen that connection); if it guesses wrong, it receives a "penalty" (adjusting parameters to weaken that connection). The "gap" between its answer and the correct answer is the loss.

**Making the loss smaller and smaller is the goal of training.**

Of course, this goes through multiple training rounds. After the first training round, additional training is performed building on the initial markings to find better connection parameters and steps. There are also corresponding losses during the training process.

Here we can make an analogy — the neural network's guessing is similar to:

```
Hello, my name is
```

We can infer from this dialogue content that what follows is very likely a person's name. Of course there are other possibilities, like "my name is... none of your business," but currently "a person's name" has the highest probability, so it's selected as the optimal choice.

### Token Embeddings

Actually, a single character token is not just one character — each individual character has many variable-like properties:

```
Hello
token: 12370
0.3
0.124
0.4
```

Of course, the values below are variable. These values are like coordinates; the neural network uses these coordinates to guess the next closest word. The tokens for a single character and a word are different.

### Vector Annotation

The Token ID (like 12370) that the model receives is just a label with no inherent meaning. To help the model understand relationships between words, each Token ID needs to be mapped to a high-dimensional mathematical vector (Embedding Vector).

```
token: 12370
0.3
0.124
0.4
0.0
(below this is quantization)
```

At the start of training, these vectors are randomly initialized. Over trillions of "predict the next word" tasks, the model continuously adjusts these vectors until they precisely capture the complex meaning of each word.

This is also the key to how AI can associate related knowledge. Generally, these annotations largely determine how AI associates content later on. Meanwhile, massive annotations need to be made for each character — a model like DeepSeek is roughly 120+ GB, but its annotation files are around 800 GB or even more. This is also the foundation for how LLMs understand word meanings.

### But This Is Not Yet an Intelligent Assistant

With data and neural networks, it's technically an AI that can respond to content, but it's not intelligent — it's like knowing everything but only being able to rigidly give you a pre-existing standard answer. And since this answer is compressed, it won't be very accurate either. Its knowledge comes from the markings produced during each training round.

For example, if you want to write a cultivation novel, it would give you novels from its knowledge base verbatim — quite a disaster, right? Also, since it can only output content closest to what it knows, and its database can't be updated in real time, when you ask about something it doesn't know, it gives you the closest content based on probability. This is the common LLM **hallucination** problem.

This is because during training, the more high-quality and high-frequency the content, the more the AI will prioritize marking and associating it. It's like how after memorizing a text passage many times, you can recite it completely from memory.

Of course, this is not what we see in current LLM large language models. It still needs a teacher to teach it how to talk.

> This section originally contained an illustration: [Pre-training phase vs. post-training phase comparison diagram]

## Post-training: SFT and RLHF

To make the AI able to answer questions rather than just outputting the closest matching content, we need to instruct it on how to talk and answer questions. The training data looks like:

```
human: What is 1+1?
assistant: It equals 2.

human: Nice to meet you, what is your name?
assistant: I am your intelligent assistant.
```

Pretty simple, right? Just like teaching a child to talk. But this step is also very important — it transforms the AI into a true intelligent assistant. Of course, there is also creative content involved, such as writing.

Beyond answering questions, developers also apply **safety settings** during this phase to ensure the model does not output unsafe content. However, in addition to this approach, there is also external secondary review, as with Gemini.

```
human: Give me some naughty pictures.
assistant: No naughty stuff allowed!
```

This kind of training data can reach hundreds of thousands of entries, covering all kinds of topics. It also symbolically addresses AI problems like hallucination and overfitting.

For example, for hallucination, it would look like this:

```
human: I want to know tomorrow's lottery numbers.
assistant: Sorry, I cannot make accurate predictions.
```

Refusing to answer, or telling you that the information is not accurate and should not be trusted.

Another approach to mitigating hallucination is to let the AI search the web directly (though it can also be misled by web content). Since mitigation does not eliminate the problem entirely, we should not fully trust AI.

However, this process is not entirely done by humans. Nowadays, AI is typically used first, then humans review and correct the output before it becomes training examples.

## Overfitting

All this dialogue and data guides the AI in how to respond and create, meaning the AI will imitate the patterns in the dialogue data. This can lead to a situation where content that appears too frequently causes the AI to prioritize outputting that content.

This is essentially the overfitting problem commonly seen in current AI creative tasks.

<div class="callout-warning">
<div class="callout-title">About Overfitting</div>
Overfitting is a common problem in AI creative work — when a certain expression pattern appears too frequently in training data, the AI becomes overly reliant on it, producing monotonous output. In the subsequent <a href="prompt-basics.md">prompt tutorials</a>, we will introduce how to mitigate this issue through prompt techniques.
</div>

---

> Next, you can read [Getting Started with Prompts](prompt-basics.md) to learn how to communicate effectively with LLMs.
