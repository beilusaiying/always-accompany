# Chapter 3: System Architecture

> This chapter presents the complete technical architecture of the P1 pipeline: Section 3.1 gives the three-stage Contraction-Divergence-Contraction (CDC) skeleton, the invocation order of the 12-stage pipeline, and the architecture diagram; Section 3.2 walks through the pseudocode execution process node by node with a real input case; Section 3.3 defines the data-flow contracts between nodes (input/output fields and types); Section 3.4 lists all gating environment variables, design principles, and the hot-reload / self-learning disk-write mechanisms. Together these constitute the runtime skeleton and interface baseline for all algorithms in subsequent chapters.

---

## 3.1 Overall Architecture

### 3.1.1 The Three-Stage Contraction-Divergence-Contraction (CDC) Skeleton

The macro-level processing skeleton of the P1 system is **three-stage**: first contract, then diverge, then contract again. This skeleton derives from the designer's observation of the rhythm of human thought and its formalization: a stimulus input first triggers a contraction of memory retrieval (e.g., "水" (water) activates "溺水" (drowning) from individual experience, forming an anchor), then spreads along the association network to related concepts ("安全" (safety), "游玩" (recreation), "划船" (boating)—corresponding to the spreading activation process, Collins & Loftus, 1975), and finally contracts again into a directional judgment at the level of action. Divergence and convergence as alternating, distinct cognitive stages is also the classical dichotomy in research on creative cognition (Mednick, 1962; Scaffolding Creativity, arXiv:2510.26490).

The functions of the three stages are:

1. **Contraction-1**: Parenthesis channel separation + tokenization and denoising + memory recall, compressing the user input from natural language into a set of meaningful words plus context anchors. Corresponds to Step-1, Node-0, Node-1.
2. **Divergence**: Two passes of divergence starting from the anchors—the first pass produces the scattered-word pool via the SWOW association network and QKV pool intersection; the second pass produces information words via multiple paths (PPR, hop2, causal, analogy, six-degree). Corresponds to Node-2 through Node-7.
3. **Contraction-2**: Contract the information words into direction words via Hough-style many-to-one voting, then produce the final output after BLQ fine ranking and red-line culling. Corresponds to Node-8 through Node-10. Here **Node-8** is the historical designation of the BLQ multi-dimensional scorer inside transfer: it is implemented as the `calcBLQ` function (invoked inside transfer under the alias `_calcBLQ_n8`, gated by the environment variable `P1_NODE8_BLQ`, enabled by default since 2026-05-31), performing multi-signal additive scoring of direction-word candidates; Node-9 is Hough many-to-one word selection; Node-10 is exit fine ranking (`refineDirectionWords`).

In terms of data shape, the three stages manifest as data width first expanding and then shrinking: the input side is one user sentence (~10-50 characters), the intermediate divergence state expands to tens to over a hundred scattered words and information words, and the output side contracts to 15 direction-word terms injected into the main model.

**The planned LLM front-end localization layer and the three-route architecture**: The position of the LLM within P1 is characterized in the design by multiple parallel routes (defined by the designer on 2026-05-10): **Route 1** is the pure-vocabulary route with no LLM, i.e., the current production route described in this chapter (approximately 90% complete); **Route 2** places a small language model (Qwen3.5:2B) **before** SWOW divergence for front-end localization—the small model first performs semantic localization on the user input (judging which axes/sub-axis directions it falls on), then hands off to the vocabulary pipeline to execute divergence; **Route 3** places the LLM **after** SWOW divergence for direction correction and annotation; **Route C** introduces the LLM at both positions. Routes 2/3/C have been fully implemented in the lab environment but not yet merged into the production mainline. This design does not contradict the "LLM-Free" positioning: in the production mainline (Route 1), divergence, voting, and ranking depend on no LLM end to end; the LLM stage bears only the localization/annotation role, outputs no creative content whatsoever, and is an optional component (when offline, the pipeline runs along the Route 1 pure-vocabulary path). "LLM-Free" should therefore be understood as a property of Route 1, not as the absence of an LLM stage in the design (see also the fine-tuning guide and the v45 LoRA 8-Head experiment).

### 3.1.2 Complete Pipeline Invocation Order

`runPipeline` is the sole entry function of the P1 pipeline (Pipeline module), invoked by upstream `getPromptHandler` step 9. Internally, the pipeline executes the following 12 stages in strict serial order:

| # | Stage | Invocation code | One-line description |
|---|------|----------|-----------|
| 0 | Hot-reload check | `_checkHotReload(mode)` | Polls AT/TI vocabulary file modification times with a 30-second throttle; an mtime change cascades a clearing of all production caches |
| 1 | Parenthesis dual-channel | `splitBracketChannels(inputText)` | Runs before tokenization; separates genuine emotion inside parentheses into a sub-channel; formatting parentheses are exempted |
| 2 | Main-channel recall | `callNode("recall", [mainText, ...])` | Chains Node-1 tokenization + Node-2 SWOW divergence + Node-0 context/memory anchors |
| 3 | Sub-channel recall | `callNode("recall", [sub, ...])` | Parenthesis content runs an independent pass of recallV2; scattered-word pools merged by Set union (no averaging) |
| 4 | Six-axis face divergence | `callNode("node3", [pool, ...])` | Each word in the pool is localized to 6 axes via 8 sources; each axis emits a face word set + axis decay (design = one axis localizes multiple information points; see the deviation note in Section 3.2) |
| 5 | 47 sub-axis localization | `callNode("node4", [pool, ...])` | 4-path detectors match AT term coordinates, producing the activated sub-axis hit set (design = direction-refining localization characterizing the rate of semantic change along each fine-grained direction; hit counting is a dimensionally reduced implementation; see Section 3.2) |
| 6 | Transfer (information pool + voting + divergence + word selection) | `callNode("transfer", [...])` | Contains Node-5 resource confirmation, Node-6 spatial voting, Node-7 second divergence, Node-9 direction-word selection |
| 7 | BLQ fine ranking | `refineDirectionWords(dwPool, ...)` | Gaussian gradual decay + cliff detection; filters out over-generic and redundant terms |
| 8 | Red-line culling | `isRedlineWord(term)` | Hard regex matching against four red-line classes (route words / inducement words / subjective words / diagnostic words) |
| 9 | Output assembly | `p1_act = top15`, `v5 = {...}` | Takes top15 terms as p1_act; builds the v5 structured output and pyramid layering |
| 10 | White-box collection | `getTrace()` / `clearTrace()` | Collects full-chain white-box four-question data; the pipeline reads and clears it every round |
| 11 | Asynchronous self-learning | `accumulateAxisStats` / `accumulateWordFreq` | Fire-and-forget disk writes; does not block return |

### 3.1.3 Architecture Diagram

The diagram below uses the example input "今天好累啊（真的好想休息）" (lit. "So tired today (really want to rest)") to present the full three-stage data flow from user input to `<p1_act>` injection into the main model. The stage framing in the diagram follows the design's definition of the three stages' functions (SWOW divergence belongs to the Divergence stage; the word selection that "extracts lexical nature and converts into technical terms" belongs to Contraction-2), while the arrows follow the actual execution order of the table in Section 3.1.2—hence Node-2, although executionally located inside recallV2 (execution order Node-1 → Node-2 → Node-0), functionally belongs to the Divergence stage and is drawn across frames; Node-9, although executionally located inside transfer, functionally belongs to Contraction-2:

```
 User input: "今天好累啊（真的好想休息）"
 ("So tired today (really want to rest)")
 ════════════════════════════════════════════════════════════════════════

 ┌────────────────────── Contraction-1 stage ────────────────────────────┐
 │                                                                        │
 │  ┌──────────────┐     ┌──────────────┐          ┌──────────────┐      │
 │  │   Step -1    │     │   Node-1     │          │   Node-0     │      │
 │  │  parenthesis │────>│ tokenization │───┐  ┌──>│ memory recall│      │
 │  │  dual-channel│     │  + denoising │   │  │   │  ctx+data    │      │
 │  │  splitBracket│     │  jieba+HMM   │   │  │   │  anchor      │      │
 │  │  Channels    │     │  POS particle│   │  │   │  extraction  │      │
 │  │              │     │  exclusion   │   │  │   └──────┬───────┘      │
 │  └──────────────┘     └──────────────┘   │  │          │ anchors      │
 │       main/sub             inputWords    │  │          │              │
 └──────────────────────────────────────────┼──┼──────────┼──────────────┘
                                            │  │          │
 ┌────────────────────── Divergence stage ──┼──┼──────────┼──────────────┐
 │                                          v  │          │              │
 │  ┌────────────────────────────────────────────────┐    │              │
 │  │  Node-2: SWOW QKV pool-intersection divergence │────┘              │
 │  │  → scattered-word pool swowPool                │ swowPool+centroid │
 │  │  Q=NB300 centroid  K=SWOW cues                 │ (fed to Node-0    │
 │  │  V=chained re-association                      │  for scoring)     │
 │  │  (execution order: Node-1 → Node-2 → Node-0)   │                   │
 │  └──────────────────────────┬─────────────────────┘                   │
 │                             │ swowPool (+anchors)                     │
 │         ┌───────────────────┴────┐                                    │
 │         v                        v                                    │
 │  ┌──────────────┐     ┌──────────────┐                                │
 │  │   Node-3     │     │   Node-4     │                                │
 │  │  six-axis    │────>│  47 sub-axis │                                │
 │  │  face diverge│     │  localization│                                │
 │  │  8 sources×6 │     │  4-path hits │                                │
 │  │  faceByAxis  │     │  activated   │                                │
 │  └──────┬───────┘     └──────┬───────┘                                │
 │         │ faceByAxis         │ activated/witnesses                    │
 │         v                    v                                        │
 │  ┌─────────────────────────────────────────────┐                      │
 │  │  Transfer adapter, divergence side          │                      │
 │  │  (Node-5 ~ Node-7)                          │                      │
 │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐      │                      │
 │  │  │ Node-5  │  │ Node-6  │  │ Node-7  │      │                      │
 │  │  │resource │─>│ spatial │─>│ second  │      │                      │
 │  │  │confirm  │  │ voting  │  │diverge  │      │                      │
 │  │  │confirm  │  │IDW addtv│  │5 paths  │      │                      │
 │  │  │Count    │  │temp.    │  │PPR/hop2 │      │                      │
 │  │  │relations│  │radius   │  │causal/  │      │                      │
 │  │  │         │  │main rank│  │analogy/ │      │                      │
 │  │  │         │  │         │  │sixDeg   │      │                      │
 │  │  └─────────┘  └─────────┘  └────┬────┘      │                      │
 │  └───────────────────────────────── ┼──────────┘                      │
 │                                     │ cleanInfoWords (info pool)      │
 └─────────────────────────────────────┼─────────────────────────────────┘
                                       │
 ┌────────────────────── Contraction-2 stage ────────────────────────────┐
 │                                     v                                 │
 │  ┌──────────────────────────────────────────┐                         │
 │  │  Node-9: Hough many-to-one voting         │                         │
 │  │  word selection (executes inside transfer,│                         │
 │  │  functionally belongs to Contraction-2)   │                         │
 │  └──────────────────┬───────────────────────┘                         │
 │                     │ directionWords                                  │
 │                     v                                                 │
 │  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐          │
 │  │  Node-8/10   │     │  red-line    │     │  output      │          │
 │  │  BLQ scoring │────>│  culling     │────>│  assembly    │          │
 │  │  fine ranking│     │  isRedline   │     │  p1_act[15]  │          │
 │  │  Gaussian    │     │  Word 4 rules│     │  v5 schema   │          │
 │  │  decay, cliff│     │  hard regex  │     │  pyramid     │          │
 │  │  truncation  │     │  matching    │     └──────┬───────┘          │
 │  └──────────────┘     └──────────────┘            │                   │
 │                                                   │                   │
 └───────────────────────────────────────────────────┼───────────────────┘
                                                     │
                                                     v
                                          ┌────────────────────┐
                                          │  <p1_act> XML      │
                                          │  U-shaped injection│
                                          │  into main model   │
                                          │  depth 0 (strongest│
                                          │  attention)        │
                                          └────────────────────┘

                                   (asynchronous side path) self-learning disk write
                                   axis_stats.json + word_freq.json
```

### 3.1.4 Node Adapter Layer and Fault Tolerance

All node invocations in the pipeline are wrapped by the `callNode` function of the **node adapter layer** (the node registration module). This layer implements the following fault-tolerance design:

- **Registry**: Each node file mounts its own implementation onto the global registry via `registerNode("nodeX", fn)`.
- **Transparent forwarding**: When a node is registered and does not throw, `callNode` behaves identically to a direct function call (zero overhead).
- **Degradation fallback**: When a node is unregistered (its module not yet ready) or throws an exception, the call takes the `fallback` path and returns a preset empty value; the exception does not propagate.
- **Forced switch**: The environment variable `P1_NODES_OFF=node7,transfer` can force specified nodes onto the fallback path at runtime, for fault isolation and single-node degradation testing.

This design originates from the engineering needs of multi-module parallel development. The constraint established by the designer is: provide a unified registration and inter-invocation junction for all modules developed in parallel, so that the failure or absence of any single module does not cascade into blocking the entire pipeline. This constraint corresponds to the fault isolation and bulkhead patterns in fault-tolerance engineering; the four mechanisms above—registry, transparent forwarding, degradation fallback, forced switch—are their concrete realization.

---

## 3.2 Natural-Language Execution Reference (Pseudocode)

This section walks through the processing of each node in actual pipeline execution order, using one complete input example. All data structures and thresholds come from the real code.

### Example Input

```
The user sends one sentence: "今天好累啊（真的好想休息）"
("So tired today (really want to rest)")
```

### Step -1: Parenthesis Dual-Channel Separation

```
The pipeline starts; hot-reload is checked first (skipped within the 30-second throttle window).
Then Step -1 runs, before all algorithms, before tokenization.

splitBracketChannels("今天好累啊（真的好想休息）")
  // Step-1 parenthesis extraction module

  1. Regex scan of all parenthesis pairs: PAREN_PATTERN = /[（(]([^（()）]+)[)）]/g
     1 pair hit: （真的好想休息）

  2. Exemption checks:
     - Pure numeric ordinal (1)(2)? No
     - Single-letter label (A)? No
     - "ps" side note? No
     - Empty / too short (< 4 chars)? "真的好想休息" = 6 chars, no
     → Verdict: genuine-emotion parenthesis → goes to sub-channel

  3. Split:
     main channel = "今天好累啊"        // body text after stripping genuine-emotion parentheses
     sub channel  = "真的好想休息"      // parenthesis content = actual inner thought
     hasBracket = true

  Output: { main: "今天好累啊", sub: "真的好想休息", hasBracket: true, bracketCount: 1 }
```

**Design motivation**: The designer observed that parentheses often carry genuine emotion the body text does not state—the body says "没事" ("I'm fine") while the parenthesis says "其实很难过" ("actually quite sad"). If the two were averaged, positive and negative emotions would cancel each other out; the hard rule therefore mandates **no averaging—preserve the tension**.

The main and sub channels each run an independent pass of `recallV2`, and the two scattered-word pools are merged by Set union.

### Node-1: Tokenization and Denoising (Main Channel)

```
Inside recallV2, Node-1 is first invoked to tokenize the main channel:

tokenizeNode1("今天好累啊")
  // Node-1 tokenization module

  1. jieba-wasm HMM tokenization:
     → ["今天", "好", "累", "啊"]  // ("today", "so", "tired", particle "ah")

  2. Three-tier denoising:
     - "啊" → POS particle (y, modal particle), HanLP+jieba dual-dictionary cross-validation → hard exclusion
     - "好" → BCC frequency lookup → hits DEGREE_WORDS degree-adverb table → not excluded, stored separately as intensifier
     - "今天" → BCC frequency < 500000 → kept, weight 1.0
     - "累" → BCC frequency < 500000 → kept, weight 1.0

  3. Intensifier target binding:
     "好" (degree adverb) → search forward for the nearest information word entering divergence → bound target = "累"
     → intensifiers: [{word: "好", target: "累", type: "degree"}]
     Meaning: in "好累" ("so tired"), "好" strengthens the weight of "累";
     downstream Node-3 multiplies "累" by an extra reinforcement coefficient

  Output:
    words: ["今天", "累"]         // content-word set after particle removal
    wordWeights: { "今天": 1.0, "累": 1.0 }
    intensifiers: [{ word: "好", target: "累", type: "degree" }]
```

### Node-2: SWOW QKV Divergence

```
divergeNode2(inputWords=["今天", "累"], isNoise)
  // Node-2 SWOW divergence module

  1. Original words enter the pool:
     swowPool = {"今天", "累"}
     // Note: this node has no "each word looks up topK associations, then union" path—
     // the per-word independent SWOW divergence fallback was deleted wholesale on 2026-06-03
     // under the red-line rule "no per-word divergence";
     // divergence runs only through the holistic QKV pool-intersection operation below

  2. NB300 centroid computation:
     inputCentroid = mean(NB300["今天"], NB300["累"]) → L2 normalization
     // 285K Chinese words × 300-dim Numberbatch vectors
     // (when none of the original words has a vector, a SWOW proxy centroid fallback
     //  is available, default off; the association words of that branch are used
     //  only to build the centroid and do not enter the pool)

  3. QKV pool intersection (inputVecs >= 2, condition satisfied):
     Q = inputCentroid
     K = NB vectors of all 10,024 SWOW cues (swow_zh24_official.json);
         compute dot products with Q, take top3 cues
       → assume cues hit: ["疲劳", "辛苦", "精力"]  // ("fatigue", "hardship", "energy")
     V = each top cue swowDiverge-s 3 more association words
         (distance gating filters near-synonyms with cos>=0.85)
       → "疲劳" → ["倦怠", "体力", "恢复"]  // ("burnout", "physical strength", "recovery")
       → "辛苦" → ["付出", "坚持", "努力"]  // ("devotion", "persistence", "effort")
       → "精力" → ["消耗", "充沛", "集中"]  // ("depletion", "abundance", "concentration")

  4. Exit denoising (each cue/association word is judged one by one via _isNonInfoN2 before entering the pool):
     - Original-word protection: "今天", "累" not excluded
     - Degree-adverb exemption (DEGREE_WORDS)
     - POS particles: isNoise judgment
     - BCC ultra-high frequency > 800000: excluded if hit
     - Union of 4 stopword lists: excluded if hit
     - Colloquial interrogative complement set: excluded if hit

  Scattered-word pool swowPool (Set, ≈ original words + 3 cues + 9 association words ≈ 14 words):
    {"今天", "累", "疲劳", "倦怠", "体力", "恢复",
     "辛苦", "付出", "坚持", "努力", "精力", "消耗", "充沛", "集中"}
```

**Design positioning of QKV**: In the design, "QKV understanding" is judged to be a hard problem requiring an LLM, and is the core responsibility of the planned LLM annotation layer (H5 LoRA)—the responsibility boundary established by the designer is: within P1, the LLM is responsible only for QKV understanding, direction correction, and direction annotation, and bears no creative content generation whatsoever; the basis for judging it a hard problem is the complexity of human language logic, which makes deep semantic parsing difficult to complete with pure vocabulary/vector methods. Node-2's "QKV pool intersection" here—selecting cues by NB centroid dot product—is the system-layer proxy implementation under the no-LLM route (Route 1, see Section 3.1.1), and does not mean that the QKV understanding problem has been solved by 300-dimensional vector dot products.

### Node-0: Context Recall

```
node0Recall(chatHistory, inputSwow, inputCentroid, ...)
  // Node-0 context recall module

  1. Take the most recent 6 context sentences (CTX_SENT_COUNT=6)
  2. Tokenize each sentence → SWOW divergence (top4 per word) → intersection scoring against inputSwow
  3. NB cosine: cosine of each sentence's word centroid against inputCentroid
  4. combined = swowScore + (nbScore > 0.15 ? nbScore * 10 : 0)
  5. Extract keywords from the top4 sentences → IPW inverse-propensity-weighted ranking

  Assume the context contains "我最近加班很多" ("I've been working a lot of overtime lately"):
    → anchor: {node: "加班", strength: 0.45}  // ("overtime")
    → "加班" joins swowPool and participates in localization (weight 1.0 because it is a context anchor)
```

### Sub-Channel Processing

```
Because hasBracket = true, the sub-channel "真的好想休息" runs an independent pass of recallV2:
  // Pipeline module

  Tokenization: ["真的", "好", "想", "休息"] → after denoising: ["休息"]  // ("rest")
  // Single-word input does not satisfy QKV_MIN_INPUTS=2, so QKV intersection does not start;
  // sub-channel pool = original word {"休息"}
  // (the "no per-word divergence" red-line rule applies equally in the sub-channel)

  The sub-channel pool is merged into the main-channel pool by Set union:
    newly added: {"休息"}

  Net addition to the merged swowPool: 1 word (the embodiment of tension preservation:
    the main channel's "累/疲劳" coexists with the sub-channel's "休息";
    no averaging, no cancellation)
```

### Node-3: Six-Axis Face Divergence

**Design intent (stated before the implementation)**: The design of six-axis localization is not "one axis gives one word one number," but rather **one axis localizes multiple information points for one word**—which concepts the word associates to on this axis, what information range it covers; the localization result is then transferred to the vocabulary so that a word enters subsequent stages carrying rich "information + information range." The six axes bear the triple function of **localization + refinement + divergent information points**. This design—"axis localization outputs a set of information points rather than a scalar"—is consistent with conceptual spaces theory: a concept occupies a region, not a point, in semantic space (Gardenfors, 2000), and a single scalar projection necessarily loses the region structure.

**Known deviation of the current implementation from the design**: The current code compresses each word on each axis into a single scalar score (`allAxes[axis] = v`), and faceByAxis merely takes top6 in descending scalar order—this is a dimensionally reduced execution of the design, losing the "one axis, multiple information points" information structure, and is listed for refactoring. The flow below describes the current code behavior; the reader should note its gap from the design intent:

```
axis6(swowPool, mode="chat", inputWordSet, linguisticSignals, inputCentroid, intensifiers)
  // Node-3 six-axis face module

  1. Per word, scoreWord(word, mode) — query 8 sources and compute 6 axis scores:
     "累" (user original word, weight 1.0, and reinforced by "好"):
       - cogmech_gemini (9134 words): hit → psychology: 0.45
       - DomainWordsDict (561K words): hit domain "医学" (medicine) → informatics: 0.2
       - BCC three-domain: dialogue proportion > 0.45 → psychology + signal
       - VAD: high arousal → psychology +0.08
       → allAxes: { psychology: 0.63, informatics: 0.2, sociology: 0.15, ... }

     "疲惫" ("exhausted"): allAxes: { psychology: 0.55, sociology: 0.10, ... }
     "压力" ("stress"):   allAxes: { psychology: 0.48, sociology: 0.35, cognitive: 0.20, ... }
     "工作" ("work"):     allAxes: { sociology: 0.50, informatics: 0.15, ... }
     ...

  2. faceByAxis construction (per axis, take words with allAxes[axis]>0, descending top6):
     psychology:  [{word:"累",v:0.63}, {word:"疲惫",v:0.55}, {word:"压力",v:0.48}, ...]
     sociology:   [{word:"工作",v:0.50}, {word:"压力",v:0.35}, ...]
     informatics: [{word:"累",v:0.20}, {word:"工作",v:0.15}, ...]
     cognitive:   [{word:"压力",v:0.20}, ...]
     linguistics: [...]
     logic:       [...]

  3. Axis decay (AXIS_DECAY_BETA=0.5):
     Axes ranked in descending relevance → psychology(rank0)=1.0, sociology(rank1)=0.607,
     informatics(rank2)=0.368, cognitive(rank3)=0.223, ...
     → distant axes decay but never reach zero (soft isolation)

  4. axisDiverge true divergence (_P1_FACE_ANCHOR=on):
     Each axis's face words serve as seeds → NB300 cosine search over AT terms + bridged physical-library words
     → new words injected into faceByAxis, v=similarity
```

### Node-4: 47 Sub-Axis Coordinate Hits

**Design positioning**: The 47 sub-axes are the direction-refinement layer of 6-main-axis localization—characterizing a word's rate of semantic change along each fine-grained direction within the coarse localization of the 6 main axes. The 6 main axes give the coarse localization, the 47 sub-axes give the refined localization, and the two-level localization then connects to the various external resources (SWOW / ConceptNet / Numberbatch / Cilin / CFN, etc.), the whole constituting a multi-layer interconnected structure of "**6 axes → 47 sub-axes → resource layer**": a word's activation propagates through the hierarchy and converges additively, and within it the word is localized, refined, and diverged level by level.

```
axis47(swowPool, mode, inputWordSet, wordProfiles)
  // Node-4 sub-axis localization module

  4-path hit detectors:
    path1: scattered word matches an AT term name → hits on axes_47 sub-axes
      "疲惫" matches AT → psy_emotion, psy_physiology
    path2: cogmech dimDetail → atDimToSubAxis
      "累" → psy_emotion
    path3: Domain/THUOCL → default sub-axis mapping
      "工作" → soc_work
    path4: BCC three-domain proportion >= 0.45
      "压力" high dialogue proportion → psy_emotion, soc_interpersonal

  Output:
    activated: { psy_emotion: 3, psy_physiology: 1, soc_work: 1, soc_interpersonal: 1 }
    witnesses: { psy_emotion: ["疲惫", "累", "压力"], soc_work: ["工作"], ... }
    // activation strength = number of hit words; fed via transfer to Node-6 spatial voting
```

### Node-5 ~ Node-9: Transfer (Adapter)

```
transfer(swowPool, mode, axisResult, inputCentroid, chatHistory, userCtx, intensifiers)
  // Transfer module

  ── Node-5: Resource confirmation ──
  Information pool cleanInfoWords construction:
    Deduplicate the face words of each axis in faceByAxis → per word, query AT and attach axes_47/concepts/l1_summary
    Coordinate supplementation priority: AT native > node4 activation > bridged precomputation

  refineByResources(cleanInfoWords):
    3-channel confirmation:
      at_concepts: shared concept-cluster confirmation
      cn_light: ConceptNet relation edges, 1 hop
      cilin: same Cilin minor category
    → Output: each word carries confirmCount (0-3) + relations[]
    → No coordinate change, no voting, no ranking (pure confirmation signal)

  ── Node-6: Spatial voting (main ranking, core of the whole chain) ──
  spaceVote(cleanInfoWords, targets=AT_eligible):

    For each target (AT-eligible term) t, each information word i votes:
      d = 1 - cosine(NB300[i], NB300[t])    // semantic distance
      idw = 1 / (1 + d^2 * 10)              // IDW, STEEPNESS=10
      vote(i→t) = w_i * idw                 // additive vote (w_i = information-word weight)
      totalVote(t) = SUM_i(vote_{i→t})      // accumulation, no /N

    Temperature banding:
      inputCount < 5 → T=1.5 (short sentence, larger radius, more divergence)
      inputCount > 10 → T=0.7 (long sentence, smaller radius, more precision)
      else → T=1.0
    radius = 0.12 * T

    Assume "累"+"疲惫"+"压力" jointly vote for the target "职业倦怠" ("occupational burnout"):
      totalVote("职业倦怠") = vote(累→职业倦怠) + vote(疲惫→职业倦怠) + vote(压力→职业倦怠)
      // three votes accumulate additively; no division by 3, no chained multiplication

    Anchor extraction: multi-density peaks (grouped by axis + NoveltyBonus = 1/sqrt(count+1))
    Domain-signal bonus: domainBonus = 0.3 * topWeight (additive)

  ── Node-7: Second divergence (5 paths) ──
  Starting from Node-6 anchors, 5 paths produce additional information words:

    1. PPR (PersonalizedPageRank):
       anchors → KG seeds → alpha=0.15, 15 iterations → high-scoring terms
       already in pool: score += ppr * 5 * score (HDC additive)
       new terms: normalized to the face median scale

    2. hop2 (two-hop expansion):
       anchor concepts → CN relation words → TI → AT terms
       gamma=0.75, discipline-switch bonus (cross-axis 1.0 / same-axis 0.5)

    3. causal (causal divergence):
       anchor concepts → CN causal chains (Causes/HasProperty/CapableOf/MotivatedByGoal)

    4. analogy (analogical divergence):
       main-axis anchor NB → AT terms of other axes
       inverted-U optimal semantic distance band cos [0.2, 0.7]
       ranked mode, per-anchor cap enforcing diversity

    5. sixDeg (six-degree paths):
       anchor concepts → CN full-relation 1-2 hops → SixDegreeBonus
       bonus = min(1.6, 1+0.2*(domainCount-1)), self-stop when pathDecay<0.15

  ── Node-9: Hough many-to-one word selection (the sole word-emitting path) ──
  selectDirectionWords(cleanInfoWords, ...):

    Each information word i, toward each eligible target t:
      cos47 = 47D_cosine(iw.axes_47, target.axes_47)    // >= VOTE_COS_FLOOR(0.15)
      relW = NB300_cosine(iw, target)                    // semantic relatedness
      locW = 0.3 * cos47                                 // localization vote component
      vote = iwWeight * (relW + locW + domainW)          // additive vote
      totalVote(t) += vote                               // accumulator

    score(t) = totalVote * max(decay[target.axis], 0.15)
    Additive quality gates: score' = max(score * FLOOR, score - SUM(penalty_d))
      // gate3 polarity / gate4 l1-axis / gate5 IDE / gate7 substring null-value term /
      // gate7b derivable-from-bare-reading / gate9 low_search / gate10 diagnostic-meta / gate11 overfit

    Pyramid layering: apex (core) / mid (extension) / base (broad-recall)

    Assume the produced top20:
      [{term:"职业倦怠", score:2.8, axis:"psychology"},   // "occupational burnout"
       {term:"能量管理", score:2.1, axis:"cognitive"},    // "energy management"
       {term:"社会支持", score:1.9, axis:"sociology"},    // "social support"
       {term:"压力应对", score:1.7, axis:"psychology"},   // "stress coping"
       ...]
```

### Node-10: BLQ Fine Ranking and Red-Line Culling

```
refineDirectionWords(dwPool, {inputCentroid, nb, mode, inputWords, decay})
  // BLQ module

  1. Gaussian gradual decay:
     decay = max(0.15, exp(-(d - 0.45)^2 / (2 * 0.25^2)))
     // d = NB300 cosine distance, PEAK=0.45, SIGMA=0.25

  2. Cliff detection:
     if precedingWord.score > followingWord.score * 3 (CLIFF_RATIO=3) and position >= 5 (CLIFF_MIN=5)
     → truncate; do not force-fill 15 entries
     // prevents low-quality direction words from being padded into the output

  3. finalScore = node9Score * gaussDecay
     // Gaussian decay is soft positioning ("computes position, does not crush scores"):
     // it does not override the Node-9 voting order
```

**Evolution note on BLQ's fusion mode**: An early version of Node-10 contained a `min(factors)` quality gate (the weakest of the multiple factors was multiplied into the final score, equivalent to an AND gate), which contradicted the additive-fusion hard rule established for the system (spatial additive convergence rather than linear multiplication, rather than hard matching—corresponding to the OR-gate semantics of CombSUM, Fox & Shaw, 1994)—if any factor tends to zero the whole score collapses, which is precisely the opposite of the "multi-axis resonance bonus" (OR logic). That factors layer was deleted wholesale on 2026-06-03 under the red-line rule (measurement showed it was dead code never multiplied into scoring, though the white-box display layer still shows `min(factors)` as a soft down-weighting factor, inconsistent with the actual scoring behavior). The actual structure of current BLQ is two layers: the **inner layer** is Node-8 `calcBLQ`'s multi-signal weighted CombSUM (six additive bonus channels—spatial / BM25 TF saturation / pathHarmony / NB / spec / resource confirmation—summed linearly, minus additive suppression deductions each applied in exactly one place; no chained multiplication, no averaging); the **outer layer** is Node-10's `node9Score × Gaussian gradual decay` (the multiplier is soft positioning, not a quality gate). The basis of the evolution from "multi-factor product" to "additive CombSUM" is the additive-fusion hard rule above and the designer's explicit correction of product-style fusion—a product lets any single weak factor veto the whole, contrary to the design goal of complementary multi-signal fusion.

```

isRedlineWord(term):
  4 red-line hard regex matches:
    R1 route words:       /建议|应该|方法|步骤|策略/      // suggest|should|method|steps|strategy
    R2 inducement words:  /你需要|你必须|快去|赶紧/       // you need to|you must|go now|hurry
    R3 subjective-experience words: /你很|你好|你觉得|感觉很/  // you are so|you're|you feel|feels very
    R4 diagnostic words:  /症(?!状)|障碍|综合征|确诊/     // -osis (excl. "symptom")|disorder|syndrome|diagnosed
    hit → hard cull

  → final p1_act = the array of top15 direction-word terms
```

### Output Assembly and Injection

```
return {
  p1_act: ["职业倦怠", "能量管理", "社会支持", ...],  // top15 terms
  v5: {
    K: ["职业倦怠", "能量管理", "社会支持", "压力应对", "情绪调节", "自我关怀"],  // top6
    linguistics: null,          // first direction word with axis=linguistics
    logic_strong: "能量管理",   // first with axis=logic|cognitive
    psychology_axis: "职业倦怠", // first with axis=psychology
    diverge_anchors: ["职业倦怠", "社会支持"],  // two adjacent words of different axes (divergence anchors)
  },
  directionWords: [{term, score, axis, source, _pyramid, ...}],  // top20 full objects
  pyramid: { apex: [...], mid: [...], base: [...] },             // null when P1_PYRAMID=off
  cleanInfoWords: [...],
  trace: { step1_bracket, recall, axis, node5, node10, transfer, total_ms },
  whitebox: Map,
}

// getPromptHandler wraps p1_act into <p1_act> XML and injects it into depthInjections (depth 0)
// U-shaped arrangement: top1 first (primacy effect), top2 last (recency effect), top3 in the middle (weakest position)
```

---

## 3.3 Data-Flow Contracts

### 3.3.1 Step -1 Parenthesis Dual-Channel

**Input**:
```json
{ "text": "string (raw user input, untokenized)" }
```

**Output**:
```json
{
  "main": "string (main channel: body text after stripping genuine-emotion parentheses, whitespace normalized)",
  "sub": "string | null (sub channel: non-exempted parenthesis contents concatenated in order of appearance; null if none)",
  "hasBracket": "boolean (whether genuine-emotion parentheses exist)",
  "bracketCount": "number (count of genuine-emotion parentheses)"
}
```

### 3.3.2 recallV2 (Node-0 + Node-1 + Node-2 + Pool)

**Input**:
```json
{
  "text": "string (main-channel body text)",
  "chatHistory": "[{role, content}] (recent dialogue history)",
  "seenNodes": "Set (SWOW deduplication set)",
  "opts": {
    "memDirs": "[string] | null (character-level + _global memory root directories)",
    "excludeWords": "[string] (excluded words, e.g., username/character name)",
    "mode": "string (chat|code|ide|work|airp)"
  }
}
```

**Output**:
```json
{
  "inputWords": ["string (user original words after particle removal, e.g., ['今天','累'])"],
  "swowPool": "Set<string> (scattered-word pool, ~20 words)",
  "inputCentroid": "Float32Array(300) | null (NB300 centroid vector)",
  "anchors": [
    {
      "node": "string (anchor word)",
      "strength": "number (0.0-0.7, ctx anchor > data anchor)",
      "_combined": "number",
      "_nbCos": "number",
      "_source": "string ('ctx'|'data')"
    }
  ],
  "linguisticSignals": {
    "particles": "object (modal-particle detection)",
    "metadiscourse": "object (metadiscourse detection)",
    "burns": "object (absolutization detection)"
  },
  "intensifiers": [
    {
      "word": "string (degree adverb / negator, e.g., '好')",
      "target": "string (bound content word, e.g., '累')",
      "type": "string ('degree'|'negation')"
    }
  ]
}
```

### 3.3.3 Node-3 Six-Axis Face Divergence

**Input**:
```json
{
  "words": ["string (scattered-word pool array)"],
  "mode": "string",
  "inputWordSet": "Set<string> (user original words + ctx anchors, weight 1.0)",
  "linguisticSignals": "object",
  "inputCentroid": "Float32Array(300) | null",
  "intensifiers": "[{word, target, type}]"
}
```

**Output**:
```json
{
  "wordProfiles": [
    {
      "word": "string",
      "mainAxis": "string (highest-scoring axis)",
      "mainScore": "number",
      "allAxes": { "psychology": 0.63, "informatics": 0.2, "...": "..." },
      "dimDetail": "object (8-source detail)",
      "sources": ["string (names of hit sources)"],
      "dimSignals": "object | undefined"
    }
  ],
  "faceByAxis": {
    "psychology": [{"word": "累", "v": 0.63, "vRaw": 0.63, "dimSignals": "..."}],
    "informatics": ["..."],
    "sociology": ["..."],
    "logic": ["..."],
    "linguistics": ["..."],
    "cognitive": ["..."]
  },
  "axisDecay": { "psychology": 1.0, "sociology": 0.607, "informatics": 0.368, "...": "..." },
  "mainAxis": "string (highest-relevance axis)",
  "domainSignals": { "axis": {"tags": "...", "topTag": "...", "topWeight": "number"} }
}
```

**Contract deviation note**: The contract above reflects the current implementation—`allAxes` holds a single scalar per axis, and faceByAxis face words carry only one `v` value; this is the dimensionally reduced form of the "one axis, multiple information points" design (see the deviation note in Section 3.2). The `dimDetail` field retains the 8-source detail and is the residual anchor of the design semantics in the contract; the refactoring direction is precisely to restore the multi-information-point structure and carry it through downstream.

### 3.3.4 Node-4 47 Sub-Axis Coordinate Hits

**Input**: `words`, `mode`, `inputWordSet`, `wordProfiles` (produced by Node-3)

**Output**:
```json
{
  "activated": { "psy_emotion": 3, "soc_work": 1, "...": "..." },
  "witnesses": { "psy_emotion": ["疲惫", "累", "压力"], "soc_work": ["工作"], "...": "..." }
}
```

### 3.3.5 Transfer (Node-5 + Node-6 + Node-7 + Node-9)

**Input**:
```json
{
  "wordPool": ["string (scattered-word pool array)"],
  "mode": "string",
  "axisResult": {
    "faceByAxis": "object (Node-3)",
    "domainSignals": "object",
    "axisDecay": "object",
    "activated": "object (Node-4)",
    "witnesses": "object (Node-4)",
    "_inputWords": ["string (user original words)"]
  },
  "inputCentroid": "Float32Array(300) | null",
  "chatHistory": "[{role, content}]",
  "userCtx": "{ username, charName, vocabUserDir } | null",
  "intensifiers": "[{word, target, type}]"
}
```

**Intermediate data cleanInfoWords** (information pool):
```json
[
  {
    "term": "string (word)",
    "score": "number (totalVote, written back by Node-6)",
    "axis": "string (main axis)",
    "eligible": "boolean (whether an AT-eligible target)",
    "meta": {
      "axes_47": { "psy_emotion": 0.8, "...": "..." },
      "concepts": ["string (AT concept labels)"],
      "l1_summary": "string (AT level-1 classification summary)"
    },
    "confirmCount": "number (Node-5 confirming source count, 0-3)",
    "relations": ["object (Node-5 confirmation relations)"]
  }
]
```

**Output**:
```json
{
  "directionWords": [
    {
      "term": "string",
      "score": "number (final score)",
      "axis": "string",
      "source": "string (source path)",
      "_voteCount": "number (vote count)",
      "_totalVote": "number (total vote value)",
      "_pyramid": "string ('apex'|'mid'|'base') | undefined",
      "dimKey": "string (AT dim key)"
    }
  ],
  "cleanInfoWords": ["the cleanInfoWords array above"],
  "trace": "object"
}
```

### 3.3.6 Final Output (runPipeline Return Value)

```json
{
  "p1_act": ["string, at most 15 direction-word terms"],
  "v5": {
    "K": ["string, at most 6 searchable terms"],
    "linguistics": "string | null",
    "logic_strong": "string | null",
    "psychology_axis": "string | null",
    "diverge_anchors": ["string", "string"] | null
  },
  "directionWords": ["object, top20 full direction-word objects"],
  "pyramid": {
    "apex": ["string"],
    "mid": ["string"],
    "base": ["string"]
  },
  "cleanInfoWords": ["object, full information-pool array"],
  "trace": {
    "step1_bracket": { "hasBracket": "boolean", "bracketCount": "number", "main": "string", "sub": "string|null" },
    "recall": { "inputWords": ["string"], "swowPoolSize": "number", "anchorCount": "number", "ms": "number" },
    "axis": { "faceAgg": "object", "mainAxis": "string", "topAxisRatio": "number", "positioningQuality": "string", "ms": "number" },
    "node5": { "note": "string" },
    "node10": { "before": "number", "after": "number", "filtered": "number", "filteredWords": ["object"] },
    "transfer": { "topWords": ["string"], "ms": "number" },
    "total_ms": "number"
  },
  "whitebox": "Map (white-box four-question data, always fully on)"
}
```

### 3.3.7 Overall Inter-Node Data-Passing Map

The diagram below chains the input/output fields of the nodes in Sections 3.3.1 through 3.3.6, showing the complete data-passing path from user input to the final return value:

```
userInput (string)
  |  Step-1 splitBracketChannels
  v
{main, sub, hasBracket, bracketCount}
  |  main → recallV2 (when hasBracket=true the sub channel also runs recallV2 once; Set union merge)
  v
{inputWords[], swowPool Set, inputCentroid Float32Array(300), anchors[], linguisticSignals, intensifiers[]}
  |  swowPool → array
  v
axis6(node3) → {wordProfiles[], faceByAxis:{axis:[{word,v,dimSignals}]}, axisDecay:{axis:float}, mainAxis}
  |  wordProfiles
  v
axis47(node4) → {activated:{subAxis:int}, witnesses:{subAxis:string[]}}
  |  faceByAxis + activated/witnesses + _inputWords
  v
transfer (node5+node6+node7+node9)
  |  node5: refineByResources → each word gets confirmCount/relations
  |  node6: spaceVote → fullVoteMap writes back iw.score = totalVote
  |  node7: PPR/hop2/causal/analogy/sixDeg → new words join cleanInfoWords
  |  node9: selectDirectionWords → directionWords top20
  v
node10: refineDirectionWords + isRedlineWord → final p1_act top15
  v
{p1_act, v5, directionWords, pyramid, cleanInfoWords, trace, whitebox}
```

---

## 3.4 Gating and Environment Variables

### 3.4.1 Complete Environment Variable List

All behavior switches of the P1 pipeline are controlled by environment variables, effective at runtime with no restart required. The table below lists all gating variables, their default values, and their functions.

| Environment variable | Default | Function | Code location |
|----------|--------|------|----------|
| `P1_BRACKET` | `on` (on unless "off") | Step-1 parenthesis dual-channel switch | Pipeline module |
| `P1_BRACKET_MIN_LEN` | `4` | Exemption threshold for too-short parentheses (character count) | Step-1 parenthesis extraction module |
| `P1_BRACKET_SEP` | `" "` | Separator when concatenating multiple sub-channel fragments | Step-1 parenthesis extraction module |
| `P1_NODE1_V2` | `on` | Framework-version tokenizeNode1 | Node-1 tokenization module |
| `P1_N2_SWOW_TOPK` | `6` | swowDiverge association topK (consumed only by the centroid-fallback branch; the main path is QKV pool intersection, with pool size determined by QKV_CUES×QKV_ASSOC) | Node-2 SWOW divergence module |
| `P1_N2_SWOW_DISTANCE` | `on` | SWOW distance gating (cos>=0.85 near-synonym filter) | Node-2 SWOW divergence module |
| `P1_N2_QKV` | `on` | QKV pool-intersection switch | Node-2 SWOW divergence module |
| `P1_N2_QKV_CUES` | `3` | QKV top cue count | Node-2 SWOW divergence module |
| `P1_N2_QKV_ASSOC` | `3` | Association words per cue | Node-2 SWOW divergence module |
| `P1_NODE3_FACE` | `on` | Six-axis face-emission (not line) switch | Node-3 six-axis face module |
| `P1_AXIS_DECAY` | `on` | Axis decay switch | Node-3 six-axis face module |
| `P1_DOMAIN_SIGNALS` | `on` | Domain-signal aggregation switch | Node-3 six-axis face module |
| `P1_FACE_ANCHOR` | `on` | axisDiverge true-divergence switch | Node-3 six-axis face module |
| `P1_AXIS_AWARE_DIVERGE` | `on` | Axis-aware divergence (positional gate restricting same-group targets) | Node-3 six-axis face module |
| `P1_N4_UNIFY` | `on` | Node-4 key-name unification (theory keys → FIELD keys) | Node-4 sub-axis localization module |
| `P1_NODE7_PPR` | `!= "0"` | PPR multi-hop divergence switch | Transfer module |
| `P1_NODE7_HOP2` | `!= "0"` | hop2 two-hop expansion switch | Transfer module |
| `P1_NODE7_CAUSAL` | `!= "0"` | Causal-divergence switch | Transfer module |
| `P1_NODE7_ANALOGY` | `!= "0"` | Analogical-divergence switch | Transfer module |
| `P1_NODE7_SIXDEG` | `!= "0"` | Six-degree-path divergence switch | Transfer module |
| `P1_NODE9_LOC_VOTE` | `on` | Localization vote (47D cosine participates in voting) | Node-9 direction-word selection module |
| `P1_NODE10_BLQ` | `on` (on unless "off") | Node-10 BLQ fine-ranking switch | Pipeline module |
| `P1_REDLINE_CULL` | `on` (on unless "off") | Red-line hard-culling switch | Pipeline module |
| `P1_SELF_LEARN` | `on` (on unless "off") | Self-learning disk-write switch | Pipeline module |
| `P1_DATA_RECALL` | `off` | Data three-layer marginal-recall switch | Node-0 data-layer recall module |
| `P1_METADISCOURSE_TERMS` | `on` | Metadiscourse-term activation switch | Recall orchestration module |
| `P1_FREQ_BOOST` | `on` | Per-user word-frequency soft-boost switch | Transfer module |
| `P1_DISABLE_FREQ` | `off` | Disable the frequency feedback loop | Transfer module |
| `P1_PYRAMID` | `off` | Pyramid three-layer labeling switch | Node-9 direction-word selection module |
| `P1_HOT_RELOAD_INTERVAL` | `30000` (ms) | Hot-reload polling interval | Pipeline module |
| `P1_NODES_OFF` | `""` | Nodes forced onto the fallback path (comma-separated) | Node registration module |
| `P1_RESOURCE_DIR` | `""` | Resource-directory override path | Resource directory module |
| `P1_WHITEBOX` | `""` | White-box observability filter (fully on by default) | White-box tracing module |

### 3.4.2 Gating Design Principles

Environment-variable gating follows these design principles:

1. **Default fully on (safe-on)**: The vast majority of functional switches default to on; only `P1_DATA_RECALL` (experimental stage) and `P1_PYRAMID` (optional feature) default to off.
2. **Safe rollback (safe-off)**: Setting `P1_BRACKET=off` fully reverts to the pure single-channel path, identical to the behavior before that node went live.
3. **No restart required**: All environment variables are read once at process startup; hot-reload achieves dynamic refresh through mtime polling.
4. **Node-level isolation**: `P1_NODES_OFF` allows degrading a single node to fallback empty-value output without stopping the service.

### 3.4.3 Hot-Reload Mechanism

The P1 pipeline supports **runtime vocabulary hot-reload**: new vocabularies take effect without restarting the service process. The mechanism is as follows:

```
Hot-reload flow:
  ┌──────────────────────────────────────────────────────────┐
  │  On each runPipeline call:                               │
  │    1. Check throttle window: now - lastCheck < 30s? → skip │
  │    2. stat() reads the mtimes of the current mode's two  │
  │       vocabulary files:                                  │
  │       - activation_terms_{mode}.json                     │
  │       - transfer_index_{mode}.json                       │
  │    3. Compare against last recorded mtimes:              │
  │       - First record: establish baseline, no cache clear │
  │       - mtime changed: dirty = true                      │
  │    4. dirty → clearTransferCaches()                      │
  │       Cascade clear: transfer cache + axis cache + recall cache │
  │    5. On the next getter call the new vocabulary is      │
  │       automatically reloaded                             │
  └──────────────────────────────────────────────────────────┘
```

**Code anchor**: the `_checkHotReload` function (Pipeline module)

The propagation chain of cascading cache clearing: `clearTransferCaches()` (exported by the Transfer module) internally calls `clearAxisCaches()` + `clearRecallCaches()`, ensuring that all three cache layers—transfer, axis, recall—are invalidated and the new vocabulary is automatically loaded on the next `runPipeline` call.

**Design constraints**:
- The polling interval defaults to 30 seconds (`P1_HOT_RELOAD_INTERVAL`); each check costs only 2 `fs.statSync` system calls, a negligible overhead.
- `P1_HOT_RELOAD_INTERVAL=0` fully disables hot-reload.
- Hot-reload only triggers cache clearing; it does not modify the existing cache logic.

### 3.4.4 Self-Learning Disk-Write Mechanism

After each pipeline run completes, the following data is written asynchronously (fire-and-forget) into the per-character vocabulary directory (`vocab/user/`), for P9 offline consolidation and P1's next read:

| Write target | Invoked function | Data content | Purpose |
|----------|----------|----------|------|
| `axis_stats.json` | `accumulateAxisStats` | Aggregated six-axis face scores of this run | P9 calibrates axis weights |
| `word_freq.json` | `accumulateWordFreq` | User input word frequencies + co-occurrences | Read by P1 SWOW for weight boosting |

**Gating**: `P1_SELF_LEARN=off` disables it. When `userCtx` is missing (test/lab mode), it is silently skipped.

**Hard rules**:
- Writes execute asynchronously via `Promise.resolve().then(async () => {...})` and do not block the return of `runPipeline`.
- Write failures are silenced by a whole-block `try/catch`; nothing propagates or affects the main flow.
- The logic of the self-learning module's operators themselves is not modified.

---

*This chapter is based on the current-state code of the P1 pipeline as of 2026-07-28, comprising 21 functional modules.*
