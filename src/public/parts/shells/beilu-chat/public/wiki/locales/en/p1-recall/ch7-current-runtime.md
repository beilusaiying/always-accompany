# Chapter 7 — Current Production Contract: Attention, Context, and Caching

> This chapter describes the runtime as of 2026-08-03. Chapters 1–6 preserve P1's design ideas, older node systems, and historical experiments. When an older chapter describes “component status,” AI P1 as the only active route, or obsolete node numbers, this chapter and the current source code take precedence.

[简体中文](../../../p1-recall/ch7-current-runtime.md) · [繁體中文](../../zh-TW/p1-recall/ch7-current-runtime.md) · [日本語](../../ja/p1-recall/ch7-current-runtime.md)

## 7.1 Current modes

P1 has three valid states. The two recall engines are mutually exclusive:

| State | Self-driven P1 | AI P1 | Behavior |
|---|---:|---:|---|
| `00` | Off | Off | No P1 recall |
| `10` | On | Off | Local Node0–4 white-box recall; current default route for Chat, Code, and Work |
| `01` | Off | On | Original P1AI recall retained; current route for Smart and Bot |

The `11` state is not exposed. The host selects one owner so the engines cannot run twice, inject twice, or recursively call one another. A future experiment in which self-driven P1 runs first and passes its result to P1AI through a macro must be designed as a separate one-way pipeline, not as two simultaneously active owners.

## 7.2 Attention input contract for the current turn

Self-driven P1 gives Node0 four strictly separated unit types:

```text
user_current: current user input, exactly 1 unit
user_context: up to 5 recent user messages, newest first
data: structured Data for the current user, character, and mode
ai_output: 0 units; prior AI replies are not recall anchors
```

Data is editable, auditable long-term context. It is not a fourth duplicate appended after AI history. This contract makes the user's latest intent and user-maintained facts lead attention, reducing the chance that old model wording reinforces itself repeatedly.

“Five recent messages” limits recall anchors only. It does not mean the main model can see only five conversation turns. The host can still assemble the final prompt from the window, mode, INJ entries, preset, and context budget. P1 decides which long-term material deserves to become visible again on this turn.

## 7.3 Node0–4 white-box chain

```text
Node0  Input compilation
  ├─ current user input
  ├─ up to 5 recent user messages
  └─ Data
        ↓
Node1  Tokenization, POS, and valid anchors
  ├─ Chinese and English tokenization/POS
  ├─ time expressions: years, months, dates, 202x/xx/xx, etc.
  └─ proper nouns and phrases
        ↓
Node2  Association expansion
  └─ SWOW / ConceptNet / Cilin / ATOMIC / domain lexicons
        ↓
Node3  Multi-evidence review
  └─ BLQ / NB300 / WordNet and other signals accept or reject candidates
        ↓
Node4  Real-record recall and ranking
  ├─ Data + hot/warm/cold layers
  ├─ window-aligned Code/Work Markdown
  ├─ exact phrases, BM25, explicit time, and file creation time
  └─ layer, Top, pinned, importance, weighted/RRF signals
        ↓
recalledRecords + directionWords + trace
```

An association produced by Node2 is not a memory fact. It must return to real records in Node3/Node4 for evidence and ranking before any result may enter host context.

## 7.4 Four isolation dimensions

Runtime routing carries four dimensions together:

1. **User:** one user's data must not enter another user's request.
2. **Character:** different characters owned by the same user have different memory sources.
3. **chatId:** primarily preserves Code multi-window conversation ownership.
4. **Window/mode:** selection, short-lived state, and final ranking remain separate across current Chat, Code, and Work windows.

Persistent sources and per-turn mutable state are different. Physical source caches may be shared by user × character × mode to save memory; a full file cache need not be copied for every chat ID and window. The current input, candidate set, final ranking, and injected output must nevertheless retain chatId/window ownership and cannot be reused directly from a shared cache.

## 7.5 Data, three memory layers, and file time

- **Data:** structured, user-editable state and long-term facts; both an input and a retrieval source for P1.
- **hot:** recent, frequent, currently active material.
- **warm:** material archived for the current phase.
- **cold:** long-term history that remains available on demand.
- **Code/Work Markdown:** selected according to the current window and mode, so important content does not have to live only under `data/`.

Time is not limited to string matching inside document bodies. Explicit dates, record timestamps, and file creation time can all contribute evidence. A time match raises attention but still competes with text evidence, layer, and importance; a newer file does not automatically outrank a genuinely relevant record.

Top is also not ordinary `top_k`. It is a persistent set of signals that can move material closer to attention: pinned/top status, importance, recency, layer, and prior hits. Editing those values invalidates the source version and rebuilds the index.

## 7.6 P1 cache contract

### 7.6.1 Physical source cache

`storage_read.mjs` recursively reads JSON, JSONL, and Markdown and builds a version signature from mtime, birthtime, and size. A cache hit skips disk reads and parsing; a changed file rebuilds the source. The default and hard LRU limit is 8 scopes.

The cache key represents shareable user × character × mode physical sources. It does not copy chatId/window mutable state.

### 7.6.2 Tokenization and POS cache

`node1_tokenize.mjs` keys by full text, tokenization/POS backend, and resource identity. Only results that pass the complete contract may enter the cache; failures, missing fields, and partial results are never cached. Reads and writes clone objects so downstream mutation cannot contaminate later requests. Default capacity is 4,096; the hard limit is 16,384.

### 7.6.3 Inverted-index cache

`node4_rank.mjs` caches only a pure `docs → postings` index. Its version covers body text, metadata, file time, Top, importance, and other ranking inputs; changes rebuild it. Candidate sets, query weights, and final window rankings are never shared-result caches. The index LRU hard limit is 8, and the document-token cache is also bounded.

### 7.6.4 Resource and service lifecycle

- NB300 uses `mmap_mode="r"` so the complete vector matrix is not copied into memory at once.
- Tokenizer, ONNX POS, and optional resources load on demand.
- Tokenize/vector/llmtok HTTP services stay resident rather than spawning for every message.
- Warmup is single-flight: only one warmup can run at a time.
- Short idle periods do not shut services down by default, avoiding another cold start of roughly 20 seconds; idle exit remains configurable.

The design rule is: **share stable sources, version intermediate products, isolate per-turn state, and never cache failures.**

## 7.7 Main-model prompt caching

P1 caching removes repeated retrieval work. Prompt caching reduces repeated billing for a stable main-model prefix. They are different layers.

On Anthropic-compatible paths:

- the first breakpoint sits in the stable system region;
- the second sits before dynamic Data, after-chat material, and other volatile suffixes;
- old tool results are compressed by cumulative size while recent detail stays intact;
- below 200k tokens, the default policy prevents the model from casually executing `<contextClean>`, which would repeatedly rewrite the stable prefix;
- original user messages are protected; cleanup is recoverable hiding by default, while permanent deletion requires an explicit action.

Only provider paths that support the corresponding prompt-caching contract receive these breakpoints. The same cost claim cannot be transferred to other models.

## 7.8 White-box evidence and bug signals

A deliverable P1 run should expose at least:

- whether the original input reached Node0 and whether Chinese remained UTF-8;
- unit counts for `user_current`, `user_context`, `data`, and `ai_output`;
- whether Node1 actually produced tokens, POS, time anchors, and proper nouns;
- how many candidates entered or left each Node2/3 evidence route, with reasons;
- Node4 document count, index cache hit/rebuild status, ranking signals, and final sources;
- explicit model, resource, HTTP, timeout, and memory errors—never a silent “0 recalls.”

P9 feedback uses a structured `p1_feedback_v1` packet containing trace, candidates, hits, latency, and user feedback. P9/CLI may use it for lexicon maintenance or later fine-tuning, but one missed recall must not automatically add a word to a global lexicon. Source, scope, proposed change, and human confirmation remain required.

## 7.9 Current measured boundary

On the 2026-08-03 test machine, a backend white-box Chinese hit took about `560.9 ms`, scanned 71 documents, and returned one record. The first no-hit request took about `1157 ms`. A later full process-tree measurement peaked at about `2054.5 MiB`, roughly 6.5 MiB (0.32%) above the strict 2,048 MiB gate, so the strict 2 GiB acceptance failed. This later result superseded an earlier 1.72 GB observation.

These results show that backend propagation and the Chinese path can run end to end; they are not a stable benchmark. A publishable evaluation still needs repeated cold/warm P50 and P95 latency, peak memory, and gold-record Recall@k, MRR, nDCG, plus failure cases. Historical four-mode samples without gold records must not be advertised as “90% recall.”

## 7.10 Positioning relative to team-memory products

TencentDB Agent Memory also implements context budgets and caching: L2/L3 can be injected directly, L0/L1 can be exposed through tools, Fixed Binding and ACL constrain scope, and MemoryProxy caches session, injection, and skill state. Multi-node deployments require shared storage to avoid upstream KV-cache misses.

Beilu should not claim that such systems “have no context or caching.” The more precise distinction is this: TencentDB primarily manages team memory assets that an agent can carry; Beilu compiles, on every turn of a long-running conversation, what the model should attend to, which evidence ranks it, where it enters the prompt, and which stable computations can be reused without freezing dynamic attention.
