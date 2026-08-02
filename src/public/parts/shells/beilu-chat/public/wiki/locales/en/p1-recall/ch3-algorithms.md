# Chapter 3: Algorithm Design and Formal Description

## 3.1 Introduction

This chapter provides a complete algorithmic specification of the self-driven divergence and recall system. The system is an add-on processing pipeline serving "divergent thinking": outside the large language model (LLM), it uses rule-based computation, word-vector operations, and lightweight annotation in place of additional LLM calls, thereby supplying the main model with divergence directions at zero additional inference cost. The designer characterized its positioning as "an externalized chain of divergent thinking."

The organization of this chapter follows the logic below. Section 3.2 first establishes terminological foundations, defining the coined terms repeatedly used in subsequent sections. Section 3.3 formally describes each original algorithm in the system; each item is expanded across four layers: design motivation, formal definition or formula (with a variable table), design rationale, and comparison with related work. Section 3.4 provides the complete specification of the core scoring framework BLQ (Bilu Quality, the candidate quality scoring device inside the adapter). Section 3.5 records, in the format of "ablation and failed proposals," the proposals that were empirically disproved during algorithm evolution -- a form of negative evidence of independent value in a technical report. Section 3.6 consolidates related work and provides a tiered positioning table. Section 3.7 is the chapter summary.

One implementation status that must be declared in advance: the system's divergence main loop (runPipeline) and memory recall component (recallMemories) are currently in "component status" -- that is, the algorithms have been implemented but have not yet been reconnected to the live main chain; online retrieval is temporarily handled by a model preset; this chapter describes the component library algorithms that have been implemented and are awaiting reconnection. All specific numerical values in this chapter are annotated according to their source level: those calibrated and locked through controlled experiments are annotated as "experimentally calibrated locked values"; those that are initial values not yet subject to systematic tuning are annotated as "initial default values." All formulas are preserved verbatim in their original form, without rewriting; each formula is accompanied by a variable definition table.

## 3.2 Terminology Definitions

In order to enable readers without background in this system to understand subsequent sections with zero prior context, the coined terms repeatedly used in this chapter are defined first.

- **Information word**: an intermediate semantic unit produced during divergence. It is not output directly to the main model, but serves as raw material for downstream aggregation. Examples include intermediate concepts such as "learned helplessness" and "occupational burnout."
- **Direction word**: the final semantic unit produced by "many-to-one aggregation" of multiple information words; it serves as a "knowledge-entry seed" provided to the main model, indicating a direction of thought rather than a specific route. Examples include "cognitive restructuring" and "values clarification."
- **Null word**: a word that the main model could derive on its own by reading the bare context. Such words provide no information gain to the main model; their value is defined as zero and they are removed.
- **BLQ (Bilu Quality)**: the candidate quality scoring device inside the adapter. It additively assigns scores across multiple annotation dimensions in a single pass, for the purposes of down-weighting, filtering null words, and hard redline removal; it does not itself bear the function of "selecting directions."
- **Over-general hub problem**: the phenomenon whereby a small number of high-connectivity hub words absorb large numbers of unrelated candidates into their vicinity during divergence, causing outputs to become generalized and lose directionality. "Over-general words" (catch-all terms) are words of this type -- excessively generic words that are retrieved at high frequency for any input.
- **Redline word**: a word that violates output guidelines and is hard-removed from the candidate pool upon detection (rather than down-weighted); this includes four categories: giving a specific route, making judgments on behalf of the user, expressing on behalf of the user, and diagnosing the user with a pathological condition.
- **Axis**: an independently parallel disciplinary divergence dimension. The system employs six disciplinary axes: psychology, informatics, sociology, logic, linguistics, and cognitive science.
- **Point-position (sub-axis)**: the sub-direction coordinate at the output end. The system sets up a sub-direction coordinate space at the output end; input activates a subset of it to complete "positioning"; this step only positions and does not score.
- **0-token principle**: the design stance that the entire divergence step does not call any large language model and is fully white-box-observable throughout. Divergence is accomplished by rule-based computation, vector operations, and small-model annotation.

Where specific code implementations are referenced in subsequent sections, only module names (e.g., node8, node10, axisDecay) are used as implementation identifiers; implementation details are not expanded.

## 3.3 Formal Description of Original Algorithms

This section formally describes each original algorithm design in the system. For each item, the following are provided: design motivation, formal definition or formula (with a variable table), design rationale, and comparison with related work. The tier criteria for related work are uniformly defined in Section 3.6.1; only the tier conclusions are cited here.

### 3.3.1 Three-Phase Mechanism: Contraction–Divergence–Contraction

**Design motivation.** Large language models tend to converge to a single path during generation and are unable to perform broad-domain divergence spontaneously. This system holds that divergence capability must be borne by mechanisms outside the model: first anchor context via memory recall (contraction), then perform two rounds of associative divergence (divergence), and finally aggregate into direction words and inject into the prompt (contraction).

**Structure (shape level).**

```
Input → [Contraction] memory recall + context anchoring
      → [Divergence] associative network first divergence → spatial voting → second divergence produces information words
      → [Contraction] many-to-one voting aggregation into direction words → inject into prompt
```

**Design rationale.** The contraction phase recalls memories in a broad, tangential manner to anchor context; the divergence phase aims to prevent the main model from being trapped at a single point-position in subsequent reasoning; the system itself only provides the framework, memory, and divergence paths -- aggregation, synthesis, and reasoning are still delegated to the main model. In terms of design positioning, this system targets recall and divergence, not continuation writing or reproduction of LLM generation capability.

**Implementation excerpt (selected from the main entry runPipeline in p1_pipeline.mjs, abridged).** The three phases of "contraction–divergence–contraction" described above are realized in the main loop `runPipeline` as a chain of node calls corresponding segment by segment to the shape-level structure above: the bracket dual-channel pre-layer (Step -1) precedes tokenization, followed in sequence by recall, six axes, resource confirmation, spatial voting, many-to-one aggregation, and redline removal. For readability, only the call skeleton is retained here; degradation fallbacks, white-box traces, and hot-swap polling are omitted.

```javascript
export async function runPipeline(inputText, chatHistory, mode, userCtx) {
  // Step -1 bracket dual-channel pre-layer (before tokenization; main/sub channels do not average, preserving tension)
  const _bracket = _P1_BRACKET ? splitBracketChannels(inputText) : { main: inputText, sub: null, ... };
  const _mainText = _bracket.main || inputText;
  // Phase 1 [Contraction] recallV2: tokenization + SWOW divergence + recall anchors + input centroid
  const recallResult = callNode("recall", [_mainText, chatHistory, seenNodes, { ... }], { ... });
  const swowPool = recallResult.swowPool || new Set(inputWords);
  // …(omitted: sub-channel runs recallV2 again, Set union merged into swowPool)
  // Phase 2 [Divergence] node3 six-axis planes + node4 47 sub-axis positioning
  const _axis6  = callNode("node3", [_pool, mode, inputWordSet, ...], { ... });
  const _axis47 = callNode("node4", [_pool, mode, inputWordSet, _axis6.wordProfiles], { ... });
  // Phase 3 [Divergence] transfer: node5 resource confirmation → node6 spatial voting → node9 many-to-one direction word selection
  const transferResult = callNode("transfer", [[...swowPool], mode, confirmedAxisResult, ...], { ... });
  // Phase 4 [Contraction] node10 refineDirectionWords + isRedlineWord → direction words
  _dwPool = refineDirectionWords(_dwPool, { ... });
  const p1_act = topDirectionWords.slice(0, 15).map(d => d.term);
  return { p1_act, /* …(omitted) */ };
}
```

One correspondence between the implementation and the design document is worth clarifying: the design document's "first divergence → spatial voting → second divergence" is not realized as three independent nodes in the implementation; instead it converges into three steps node5→node6→node9 running serially within a single `transfer` module, with the six axes (node3) and 47 sub-axes (node4) performing positioning upstream.

**Comparison with related work.** Tier B (conceptual level). The core claim that "LLMs require external scaffolding to separate divergence from convergence" has been publicly stated with theoretical support in CreativeDC (arXiv 2512.23601, 2025-12) and Scaffolding Creativity (arXiv 2510.26490, 2025-10) prior to this system. However, both of those works implement the two-phase approach inside a single model via two-stage prompt/temperature or persona switching, without memory recall anchoring, spatial voting, or many-to-one aggregation; the concept comes first, but the implementation paths differ.

### 3.3.2 Spatial Additive Voting (Inverse-Distance Weighting and Temperature Circle)

**Design motivation.** Candidate aggregation should not adopt linear multiplication or hard matching; instead, additive voting should be performed in word-vector space according to content distribution, so as to avoid a low score on any single dimension multiplicatively negating the whole.

**Formula (shape level).**

```
idw = 1 / (1 + d² · k)          # inverse-distance weighting; d = semantic distance; k = scaling coefficient
boundary circle radius = scaled by temperature coefficient T     # large T → large radius → more candidates; small T → small radius → precise
vote = Σ additive accumulation (multiplication chains prohibited)
```

**Variable definitions.**

| Symbol | Meaning | Source level |
|--------|---------|--------------|
| `idw` | inverse-distance weighted vote contribution for a single candidate | — |
| `d` | semantic distance between candidate and query in word-vector space | — |
| `k` | distance scaling coefficient | experimentally calibrated locked value |
| `T` | temperature coefficient, controls boundary circle radius | — |

**Implementation excerpt (selected from p1_node6_spaceVote.mjs, abridged).** The shape-level formula `idw = 1/(1+d²·k)` and the rule "votes are additive accumulations, multiplication chains prohibited" are realized verbatim in the voting inner loop of node 6; `k` is the code constant `_P1_NODE6_IDW_STEEPNESS` (an experimentally calibrated locked value, represented by symbol here). Temperature circle radius scaling, inner-circle exclusion, and other branches are omitted:

```javascript
const d = 1 - cos;                              // spatial distance, d = 1 − cosine
// …(omitted: lower-bound gate for candidates too distant, temperature-circle inner/outer determination)
const idw = 1 / (1 + d * d * _P1_NODE6_IDW_STEEPNESS);   // inverse-distance weighting, k = steepness coefficient
let vote = w * idw;                             // additive vote = w·idw, not a multiplication chain
// …(omitted: domain signal domainBonus augmentation, accumulator key lookup)
rec.totalVote += vote;                          // accumulation; no /N throughout (spatial addition, not multiplication)
```

Here `rec.totalVote += vote` directly corresponds to the shape-level formula "vote = Σ additive accumulation (multiplication chains prohibited)": the accumulation process does not divide by vote count N and does not chain-multiply, embodying the design principle that "multi-dimensional annotation is a space, not a product."

**Design rationale.** The system employs spatial additive voting rather than linear multiplication: candidates vote according to content distribution in vector space, and results are aggregated into the same candidate pool; divergence directions should manifest as "moving through space" rather than landing at isolated points.

**Comparison with related work.** Tier between C and B. The inverse-distance weighting body proper is Shepard's (1968) classical spatial interpolation formula, a general-purpose component; "selecting candidates by distance in semantic space" is also a common patent approach (e.g., US 11086920, 2018–2021). However, the specific combination of "inverse-distance weighted voting + temperature-coefficient radius circle as boundary + additive throughout with multiplication chains prohibited" has not been found in any public work; at the combination level this may be judged D.

### 3.3.3 Many-to-One Direction Word Voting (Hough-Style)

**Design motivation.** If a single intermediate word directly produces a direction word, the output is susceptible to the contingency of that word. This system has multiple intermediate information words independently vote for the same target term, and selects the final direction word by aggregating votes, structurally suppressing "single-word direct spraying."

**Formula (shape level).**

```
each information word wᵢ → votes for candidate direction word t: vote(wᵢ, t)
direction word score = Σᵢ vote(wᵢ, t)      # many-to-one cumulative voting (Hough voting paradigm)
→ vote peak = final direction word
```

**Variable definitions.**

| Symbol | Meaning |
|--------|---------|
| `wᵢ` | the i-th intermediate information word |
| `t` | candidate direction word |
| `vote(wᵢ, t)` | vote contribution of information word wᵢ for direction word t |
| direction word score | cumulative vote count for a given direction word; the peak is the final direction word |

**Theoretical support.** This design is isomorphic with the Condorcet jury theorem: given N independent voters each with correctness probability greater than 50%, the correctness probability of majority voting is approximately 1 − (1/2)^N, growing exponentially with N -- approximately greater than 87.5% at 3 votes, approximately greater than 96.9% at 5 votes, while a single vote is only approximately 50% (hence a single vote should be down-weighted). This provides the mathematical basis for "high confidence with many votes, low confidence with a single vote."

**Implementation excerpt (selected from p1_node9_dirword.mjs, abridged).** The shape-level formula "direction word score = Σᵢ vote(wᵢ, t)" is realized in node 9 using a shared accumulator `_voteAcc`: each information word independently votes for the same candidate direction word, vote values are added into `totalVote`, and voter count is tracked in `voterCount` (i.e., the "being pointed to by how many information words" figure used for peak determination); the final score is the cumulative vote multiplied by the axis decay for that axis. Range gates, channel merging, and pyramid layering are omitted:

```javascript
// each information word wᵢ independently votes for the same eligible direction word t (true many-to-one)
const vote = iwWeight * (relW + _domainW + ...);   // vote(wᵢ, t), additive
_entryTotalVote += vote;                           // single-target accumulation: Σᵢ vote(wᵢ, t)
_entryVoterCount++;                                // voter count (the "many" in many-to-one)
// …(omitted: 47D range gate, polarity/temperature calibration)
const rec = _voteAcc.get(key);                     // unified accumulator (Hough/CN/bridge_to all converge here)
rec.totalVote  += _entryTotalVote;                 // spatial addition, not multiplication
rec.voterCount += _entryVoterCount;
// …(omitted: sorting, topN selection) → final score for each direction word:
score: cand.totalVote * Math.max(nd, _houghDecayFloor) * _resW,   // cumulative vote × axis decay nd
```

Here `rec.totalVote += _entryTotalVote` is the direct implementation of "many-to-one cumulative voting (Hough voting paradigm)"; the final line `cand.totalVote × axis decay` indicates that the many-to-one score at the output end is further multiplied by the axis decay coefficient from Section 3.3.5 -- this is not made explicit in the shape-level formula and constitutes a wiring detail added by the implementation on top of the design document (axis decay is exported from node3 and consumed by node9).

**Design rationale.** Words in associative data are essentially "points"; the system needs to convert points into "lines," and divergence is the extension of a line; output direction words should be based on the multi-dimensional additive aggregation of multiple proximate words, not on any single word.

**Comparison with related work.** Tier C (transfer layer D). The Hough voting paradigm is extremely mature (Hough 1962; VoteNet, ICCV 2019), but all existing work is concentrated in computer vision and point-cloud domains. After multiple rounds of search, no public work has been found transferring Hough-style voting to keyword/direction-word generation in natural language processing; transferring this paradigm to word selection tasks and endowing it with the structural motivation of "preventing direct spraying" is one of the more distinctive aspects of this system.

### 3.3.4 Two-Round Divergence Architecture

**Design motivation.** A single round of divergence is difficult to balance both breadth and relevance. This system employs a heterogeneous two-hop structure: after the first round of divergence, spatial voting narrows the candidates, then a second round of divergence produces information words, which are finally aggregated into direction words.

**Structure (shape level).**

```
Divergence₁ (associative network) → spatial voting (narrowing) → Divergence₂ (produces information words) → many-to-one aggregation (direction words)
```

**Design rationale.** The system's divergence unfolds with "merging" as the anchor: first retrieve prior associations and memories, then diverge based on the associative network (incorporating an attention-style query–key–value mechanism), then hand off into the next hop.

**Comparison with related work.** Tier D. The specific two-hop architecture of "two rounds of divergence with a layer of spatial voting narrowing in between, followed by a second divergence producing information words" has not been found in any public work. Tree-of-Thoughts (ToT) is a conceptual neighbor (C), but it performs homogeneous branch search with evaluation backtracking; this system performs heterogeneous two hops (divergence–voting–divergence–aggregation), which is structurally different.

### 3.3.5 Six-Axis Plane Divergence

**Design motivation.** Applications oriented toward character roleplay-style feedback require multi-disciplinary support; divergence along a single dimension is insufficient to cover different facets such as psychology, sociology, and linguistics. This system has six disciplinary axes (psychology, informatics, sociology, logic, linguistics, and cognitive science) diverge independently in parallel; each axis outputs a multi-dimensional "plane" rather than a single score; axes are isolated from one another via soft decay rather than hard cutoffs.

**Formula (shape level, axis decay axisDecay).**

```
per-axis relevance axisRelevance[axis] = Σ(contribution values of face words on that axis)
rank by relevance in descending order → axisRank, rank0 = main direction axis
axis decay axisDecay[axis] = exp(-rank · β)
  rank0 → exp(0) = 1.0 (main axis)
  rank1 → exp(-0.5) ≈ 0.607
  rank2 → exp(-1.0) ≈ 0.368
```

**Variable definitions.**

| Symbol | Meaning | Source level |
|--------|---------|--------------|
| `axisRelevance[axis]` | relevance of an axis, equal to the sum of contribution values of its face words | — |
| `axisRank` | ranking of each axis by descending relevance; rank0 is the main direction axis | — |
| `β` | axis decay rate | experimentally calibrated locked value (set to 0.5) |
| `axisDecay[axis]` | decay coefficient for the axis; exponentially decreasing with rank but always greater than 0 | — |

**Implementation excerpt (selected from p1_node3_axis6.mjs, abridged).** The three lines of the shape-level formula above -- relevance summation, descending rank by relevance, `axisDecay = exp(-rank·β)` -- are realized verbatim in `_computeAxisDecay`, where `β` is the code constant `AXIS_DECAY_BETA` (an experimentally calibrated locked value, set to 0.5). AXIS_CUTOFF soft stop and white-box trace are omitted:

```javascript
for (const axis of AXES) {                        // per-axis relevance = sum of face word contribution values on that axis
  axisRelevance[axis] = fw.reduce((s, x) => s + (x.v || 0), 0);
}
const ranked = AXES.slice().sort((a, b) => axisRelevance[b] - axisRelevance[a]);   // descending by relevance
ranked.forEach((axis, rank) => {                  // rank0 = main direction axis
  axisRank[axis] = rank;
  // decay as exp(-rank·β): rank0 (main axis) = 1.0; distant axes decay exponentially but >0, never deleted
  axisDecay[axis] = axisRelevance[axis] > 0 ? +Math.exp(-rank * AXIS_DECAY_BETA).toFixed(4) : 0;
  // …(omitted: AXIS_CUTOFF soft stop determination, cutoffRatio recording)
});
```

`Math.exp(-rank * AXIS_DECAY_BETA)` is exactly consistent with the shape-level formula `exp(-rank·β)`. One implementation convention is worth noting: an axis with zero relevance has its decay set to 0 (rather than `exp(0)=1`), so as to prevent an inactive axis from being mistakenly treated as the main axis -- this is the boundary handling of the formula in the implementation.

Distant-axis decay coefficients decrease exponentially but never reach zero, realizing "soft isolation": axes far from the main direction still retain a faint contribution, permitting moderate tangential associations without outputting completely unrelated content.

**Design rationale.** Character roleplay feedback requires parallel support from multiple disciplines including writing, psychology, linguistics, and logic; divergence may be tangential, but should not output entirely unrelated content. The number of disciplinary axes was determined through an evolution from four axes to five axes to six axes; the designer rejected proposals to further reduce dimensionality.

**Comparison with related work.** Tier C (numerical/conceptual naming collision). Biber's Multi-Dimensional Analysis (MDA, 1988), LIWC (2001), and the "six supporting disciplines" of cognitive science all use words like "multi-dimensional" and "six," but none of them is a mechanism of "six disciplinary axes diverging independently in parallel, each producing a multi-dimensional plane rather than a score, with soft decay between axes" (mechanism level may be judged D); moreover, the list of disciplines also differs -- this system includes informatics, logic, and cognitive science axes, but not philosophy, anthropology, or neuroscience.

### 3.3.6 Sub-Axis Activation Positioning (Positioning Only, No Scoring)

**Design motivation.** At the output end, a high-resolution directional coordinate space is needed to map input to specific sub-directions; the function of this step is "positioning" rather than "scoring," and the two should be clearly separated.

**Structure (shape level).**

```
output end = sub-direction coordinate space (sub-axis set)
activated subset = sub-directions hit by input (spotlight attention: illuminating a direction brightens it)
→ positioning (no scoring)
```

**Design rationale.** The number of sub-direction coordinates at the output end is large; their behavior is analogous to a statistical-physics ensemble -- a large number of particles superimposed to give rise to a macroscopic state. The output-end sub-axes and the six disciplinary axes are two separate layers; sub-axes are not slices subordinate to the six axes.

**Comparison with related work.** Tier D (conceptual neighbor C). The output-end sub-axis coordinate mechanism of "activate a subset for positioning, positioning only with no scoring" -- which explicitly distinguishes "positioning" from "scoring" -- has not been found in any public work. Axis-Aligned Subspace Bayesian optimization (arXiv 2504.06111, 2025-04, score-driven) and neuron polysemanticity research (arXiv 2505.07831) are distant conceptual neighbors whose purposes and mechanisms do not match.

### 3.3.7 Bracket Dual Channel

**Design motivation.** In conversational text, bracketed content frequently carries meta-linguistic information at a different level from the main text (e.g., actions, stage directions, tone annotations). If this content is mixed with the main text and averaged, the tension between the two is dissolved. This system treats bracketed content as a meta-linguistic sub-channel, processed separately from the main-text primary channel.

**Structure (shape level).**

```
main text → primary channel processing
bracketed content → meta-linguistic sub-channel (processed independently)
two channels not mixed, not averaged → tension preserved
```

**Design rationale.** The two channels are not averaged, in order to preserve the tension between opposing signals and prevent mean-averaging -- a dimensionality-reducing operation -- from flattening mutually conflicting signals.

**Comparison with related work.** Tier C. Conceptual words such as "multi-channel separation without mixing" and "preserving tension" appear in User-Stream Routing for full-duplex speech (arXiv 2605.10199, 2026-05) and narrative tension research (arXiv 2604.09854, 2026-04), but the specific practice of "treating bracketed content in dialogue as a meta-linguistic sub-channel, separating it from the main-text primary channel, and not averaging" has not been found in public work (mechanism level D); the related works also mostly date from April–May 2026, after or parallel to this system's design period. This is one of the more distinctive aspects of this system.

### 3.3.8 Broad Tangential Recall

**Design motivation.** Unlike retrieval-augmented generation (RAG), which pursues precision, this system's recall serves downstream divergence: it adopts a low-threshold, high-volume, fuzzy recall strategy; recall results serve only as anchors and do not dominate the divergence direction.

**Formula (shape level, weighted linear recall scoring).**

```
composite = 0.45×relevance + 0.20×recency + 0.20×attention + 0.15×weight
scoreRecord = max-pool (take the strongest same-direction node across all query nodes for a given record)
```

**Variable definitions.**

| Symbol | Meaning | Source level |
|--------|---------|--------------|
| `relevance` | semantic relevance | — |
| `recency` | temporal recency | — |
| `attention` | attention concentration | — |
| `weight` | memory importance weight | — |
| weight coefficients 0.45/0.20/0.20/0.15 | linear combination weights for each component | experimentally calibrated locked values |
| `scoreRecord` | final score for a memory record, taking the maximum value across all query nodes for that record | — |

**Design rationale.** Recall is performed in a broad, tangential manner; its mechanism is "context plus attention concentration plus multi-axis" to match prior content (e.g., data layer, hot layer, cold layer) and retrieve it, without requiring highly intelligent judgment -- essentially keyword matching, which is also the source of the principle that "recall does not consume LLM tokens."

**Comparison with related work.** Tier B (means level). "Low-threshold, high-recall, associative fuzzy recall" as a technical means has already been implemented and predates or is contemporaneous with this system in HippoRAG (arXiv 2405.14831, 2024-05), SYNAPSE (arXiv 2601.02744, 2026-01), and Predictive Associative Memory (2026-02). However, the purpose and role of recall in those systems is to improve retrieval accuracy or multi-hop question answering performance, pursuing "precision"; the purpose and role of recall in this system is the opposite -- recall serves only as a divergence anchor, does not dominate, is deliberately kept fuzzy to open up candidates, and provides fuel for downstream divergence, pursuing "broad and fuzzy." The means level collides (B); the purpose and role level does not.

It should be particularly noted that SYNAPSE (2026-01-06, prior to this system) shares the three terms "spreading activation," "lateral inhibition," and "fan-out effect" with this system, but the uses are orthogonal (the former for retrieval question-answering accuracy, the latter for divergent generation). A deeper implementation-level similarity beyond the abstract cannot be ruled out; this item is listed as a priority for manual review.

### 3.3.9 Query–Key–Value Pool Convergence Divergence

**Design motivation.** Isolated, unconnected candidate words lead to excessive divergence drift. This system adapts the query–key–value (QKV) structure of the attention mechanism into an add-on divergence pipeline, using attention filtering to control drift.

**Formula (shape level).**

```
Q = input word-vector centroid
K = associative network cue (aggregated anchors = input keywords + recallAnchors)
V = convergence cue → chain re-association → divergence words injected into XML
attention(Q, K) = softmax(Q · Kᵀ / √d)     # low-attention candidates filtered (drift control)
```

**Variable definitions.**

| Symbol | Meaning |
|--------|---------|
| `Q` | query; takes the centroid of input word vectors |
| `K` | key; takes associative network cues (aggregation of input keywords and recall anchors) |
| `V` | value; takes convergence cues and produces divergence words via chain re-association |
| `d` | word-vector dimension; `√d` is the scaling factor |
| `attention(Q, K)` | attention weight, used to filter low-attention candidates for drift control |

**Design rationale.** Divergence proceeds from aggregated content; isolated, unconnected words lead to excessive drift, hence the attention mechanism is introduced; simultaneously reference semantically proximate words and recall anchors to anchor the scope of divergence.

**Comparison with related work.** Tier C (conceptual analogy naming collision). "Attention as retrieval/associative memory" has been a common interpretation since 2017 (modern Hopfield networks are equivalent to attention, Ramsauer 2020); "query centroid" appears as a naming collision in key-value acceleration work (CSAttention, 2026-04). However, the specific usage of "adapting the QKV triple into an add-on divergence pipeline with Q as word-vector centroid, K as associative network cues, and V as convergence cues for chain re-association" has not been found in any public work (pipeline usage level D).

### 3.3.10 Large–Medium–Small Three-Level Routing

**Design motivation.** Global scoring is easily dominated by over-general words and high-connectivity hub words. This system uses a three-level inverted-index routing (large-category direction, medium-category local, small-category terms) in place of global scoring, structurally addressing the over-general hub problem.

**Structure (shape level).**

```
trigger word → inverted-index activation of sub-categories (medium) → local fine-ranking (small-category term pool)
= book analogy: table of contents (large) → chapters (medium, stackable) → text (small, terms)
```

**Design rationale.** The large category provides the broad direction; the medium category provides local directions (stackable); the small category is the term pool leading to specific terms; the analogy is to a book's table of contents, chapters, and text, where table-of-contents (medium category) entries can be combined with one another. The purpose of this three-level division is to prevent hub words from absorbing everything.

**Comparison with related work.** Tier B (structural level). "Coarse-to-fine, large–medium–small hierarchical routing with inverted index" is a mature information retrieval paradigm (HRR, arXiv 2503.02401, 2025-03; CITADEL, 2022-11; inverted index, 1970s), all predating this system. However, "trigger words activating sub-categories via inverted index then local fine-ranking, with an explicit design goal of addressing the over-general hub problem" has not been found in direct correspondence -- general hierarchical retrieval targets efficiency and precision, while this system targets the divergence quality motivation of "preventing hub words from absorbing everything."

### 3.3.11 Hot-Swappable Lexicons as Additional Divergence Axes

**Design motivation.** The system seeks to extend divergence capability directly by adding lexicon files: adding one lexicon file is equivalent to the system gaining one additional divergence axis, and this supports hot-loading at runtime.

**Structure (shape level).**

```
Three-layer lexicon (priority: learned > packs > core, analogous to input method):
  core/    built-in, non-deletable with deployment (swow / cooccur / cilin / cogmech)
  packs/   pluggable, takes effect at runtime (e.g., acg-chinese 27878 words / medical / airp-techniques etc.)
  learned/ per-user self-learning from dialogue
mtime 30s check → modify file → auto-reload within 30s
typing-style boost: userBoost(word) = log(1+freq[word]) × 0.1   (cap +0.3)
```

**Variable definitions.**

| Symbol | Meaning | Source level |
|--------|---------|--------------|
| `freq[word]` | occurrence frequency of a word in the user's dialogue | — |
| `userBoost(word)` | typing-style boost amount, growing logarithmically with frequency | — |
| coefficient 0.1, cap +0.3 | boost scaling coefficient and ceiling | initial default values |
| mtime check interval 30s | file modification time polling interval | initial default value |

**Design rationale.** The system pursues lexicon hot-swappability and usage adaptability, making its behavior adjust to user habits like typing; having the model autonomously build and adjust lexicons based on dialogue is considered the superior path.

**Comparison with related work.** Tier C (infrastructure naming collision). "Hot-loading lexicons/plugins" is extremely common infrastructure (e.g., Elasticsearch dictionary hot-loading, 2020-11; Obsidian Hot-Reload; various file-watch-and-reload mechanisms); file modification time polling collides in name. However, "each added lexicon file being automatically equivalent to the system gaining one additional divergence computation axis" -- the semantic of equating a lexicon file with a divergence dimension -- has not been found in any public work (D). SillyTavern's World Info is the nearest ecosystem neighbor (keyword lexicon hot-loading), but its mechanism is "trigger then inject fixed text," not "add a new divergence axis"; the mechanisms differ.

### 3.3.12 Two-Level Vocabulary System and Null-Word Criterion

**Design motivation.** The system needs to distinguish two types of semantic units and apply an information-gain constraint: intermediate information words are not leaked externally; only after many-to-one aggregation into direction words are they output. Simultaneously, "whether the main model could already derive the word from the bare text" serves as the criterion for a word's value, filtering out null words that provide no information gain.

**Structure (shape level).**

```
information words (intermediate, not output) → many-to-one aggregation → direction words (output, knowledge-entry seeds)
null-word criterion: words that the main model can derive from bare reading = null words = value 0
direction word admission: 6 conditions all satisfied: searchable + consensus-based + is a direction word + not a diagnostic word + not a route word + not colloquial
```

The system describes the information hierarchy using a geometric "point–line–plane–volume" model:

- Volume = complete information of a user's single conversation (input plus memory data);
- Plane = recall, associative divergence, and information words (e.g., "learned helplessness," "occupational burnout"), not output;
- Line = output direction words (e.g., "cognitive restructuring," "values clarification"), output;
- Point = the main model's final reply organized according to the direction words.

**Design rationale.** Words in associative data are "points"; they must be converted into "lines," and divergence is the extension of a line; what the system should give the main model is "direction," not "routes." The organization of direction words follows four priority principles: experiential words take priority over technical terms, colloquial anchors take priority over abstractions, experiential words take priority over needs-based words, and anchor points are preserved during merging.

**Comparison with related work.** Tier between C and D. "Seed words/priming" loosely collides conceptually (Seeding priming, 2023–24). However, "a two-level vocabulary system consisting of information words (intermediate, not output) and direction words (output, many-to-one aggregation), together with the information-gain criterion of 'words that the base model can already derive = null words with value zero'" has not been found in any public work. Defining null words as those whose value is zero because the base model could already derive them is a quite distinctive criterion design (D) and is one of the clearly original aspects of this system.

### 3.3.13 BLQ Multi-Dimensional Additive Scoring Framework

**Design motivation.** If a multiplication chain is used for comprehensive scoring of candidate words, it is equivalent to an AND gate: a low score on any single dimension multiplicatively negates the whole, causing a candidate to be killed by a single dimension. This system uniformly employs a one-pass additive scoring (CombSUM) across multiple annotation dimensions, supplemented by lateral inhibition and Maximum Marginal Relevance (MMR) quota, giving the scoring an OR-gate semantics.

**Formula (shape level; see Section 3.4 for details).**

```
additive = W_SPATIAL·dSpatial + W_TF·dTf + W_PATH·dPath
         + W_NB·dNb + W_SPEC·dSpec + W_CONFIRM·dConfirm   (weighted CombSUM, no chain multiplication, no averaging)
blqScore = max(additive · FLOOR, additive − Σpenalty)      (inhibition dimensions additive penalty + soft floor)
```

**Design rationale.** Multi-dimensional annotations constitute a "space," not a multiplicative relationship; an earlier formulation was "take the mean of multi-axis scores, and delete if below threshold," but the averaging approach was subsequently rejected and changed to additive -- because averaging zeroes out the tension between dimensions.

**Comparison with related work.** Tier B (component level). The three major components -- CombSUM (Fox & Shaw 1994), MMR (Carbonell & Goldstein 1998), and lateral inhibition -- are classical information retrieval and neuroscience components with decades of history, long predating this system; SYNAPSE (2026-01) also uses lateral inhibition for memory. However, "CombSUM + lateral inhibition + MMR quota assembled as a unified set, with the explicit design argument that 'additive is an OR gate countering the AND gate of being negated by a single dimension in a multiplication chain'" has not been found in any complete public framework. The system's originality claim lies in the argument for why additive is necessary rather than multiplicative, and the specific arrangement of the three components together, not in any single component. The complete specification of this framework is in Section 3.4.

### 3.3.14 0-Token White-Box Stance (Cross-Cutting Principle)

**Design motivation.** This is a design principle that cuts across the entire divergence step rather than a single algorithm: the entire divergence process does not call any large language model, is fully white-box-observable throughout, and is accomplished by rule-based computation, vector operations, and small-model annotation, so as to avoid spending LLM API costs on a single divergence step.

**Design rationale.** The system consistently targets zero cost and does not use high-cost large models for steps like divergence; observationally, a white-box stance is adopted, directly inspecting actual output rather than relying on proxy scoring tools.

**Comparison with related work.** Tier D (competitive landscape level). Among the closest comparable approaches, this system is the only one that achieves "0-token, divergence step requiring no large model" (SA-RAG, FS-RAG, LWOW, and MAD all require large-model involvement in divergence or retrieval). Related research (MAD and LiveIdeaBench) further indicates that "a large model's divergence ability is uncorrelated with its general intelligence score," meaning investing more large-model compute does not solve the divergence problem, which indirectly supports the rationality of this system's add-on 0-token approach. In terms of the specific mechanisms governed by this principle, multi-disciplinary coordinate positioning (the second step) and re-divergence along coordinates (the third step) form a relatively novel combination.

**Summary (Section 3.3).** Item-by-item verification indicates that, in the strict sense of "mechanism highly similar and published before this system's design period (2026-04)," none of the original items above collide with public work. Collisions are mostly with general-purpose components (tier B) or conceptual/terminological naming (tier C). The system's originality claims generally fall at the level of "assembling mature components into an add-on pipeline serving divergence, transfer usage in generation tasks, and certain specific criteria," rather than at the level of any single component. Tier definitions and a summary table are in Section 3.6.

## 3.4 BLQ Scoring Framework: Complete Specification

This section provides the complete specification of the BLQ scoring framework. The functional positioning of BLQ is as a candidate quality scoring device inside the adapter, not as a divergence engine or selector: the "selection" of directions is borne by spatial voting and many-to-one voting; BLQ, after selection, performs only down-weighting, null-word filtering, and redline removal.

### 3.4.1 Wiring Status

Before the complete specification, the wiring status of each component must be honestly declared. The BLQ scoring core (calcBLQ) implements the complete multi-dimensional additive framework; the code exists and can be read line by line, but it has not yet been wired into the divergence main loop -- online information word scoring is currently handled by spatial voting and axis decay; the direction word fine-ranking component (node10) uses a simplified version of the scoring core, executing only Gaussian decay and redline removal, not the full six-dimensional CombSUM; the redline hard-removal component and the direction word fine-ranking component are currently in live-active status. The complete six-dimensional framework described in this section is a "implemented, awaiting reconnection" component library algorithm. Accordingly, specific weights and coefficients are annotated by source level throughout.

### 3.4.2 Six Additive Scoring Dimensions (CombSUM)

The structure of the BLQ scoring core is: six additive scoring dimensions weighted and linearly summed (CombSUM), then subtracting the additive penalties of several inhibition dimensions. The design ironclad rule is: no full product, no averaging. The six additive scoring dimensions are as follows.

| Dim | Name | Formula (verbatim) | Weight | Weight source level |
|-----|------|--------------------|--------|---------------------|
| N1 | Spatial distance dSpatial | `const dSpatial = Math.tanh(rawScore);` | `W_SPATIAL: 1.0` (primary signal) | experimentally calibrated locked value |
| N2 | BM25-TF saturation dTf | `const dTf = _bm25Tf(tf);`, where `_bm25Tf(f) = f/(f+k1·(1-b+b))` (in this scenario average document length = 1, degenerates to `f/(f+k1)`) | `W_TF: 0.6`; `BM25_K1: 1.5`; `BM25_B: 0.75` | experimentally calibrated locked value |
| N3 | Cross-disciplinary path harmony dPath | `const dPath = Math.log(1+disc)/Math.log(1+6);` (log-normalized, six axes as ceiling) | `W_PATH: 0.4` | experimentally calibrated locked value |
| N4 | Neighborhood relevance dNb | `const dNb = nbCos != null ? Math.max(0, nbCos) : 0.3;` (neutral value 0.3 when no neighborhood information available) | `W_NB: 0.5` | experimentally calibrated locked value |
| N5 | Specificity dSpec | `const dSpec = spec;` (more specific = more additive score; suppresses generalized over-general words) | `W_SPEC: 0.4` | experimentally calibrated locked value |
| N6 | Resource confirmation dConfirm | `const dConfirm = _confirmCount>0 ? Math.log(1+_confirmCount)/Math.log(1+6) : 0;` (log-normalized to six-channel ceiling) | `W_CONFIRM: 0.3` | experimentally calibrated locked value |

**Variable definitions.**

| Symbol | Meaning |
|--------|---------|
| `rawScore` | raw score from spatial voting, compressed into [0,1) via tanh to prevent a single spatial vote from monopolizing |
| `tf` | candidate term frequency, processed via BM25 saturation function |
| `k1`, `b` | BM25 term-frequency saturation and length normalization parameters |
| `disc` | number of distinct disciplines covered by the candidate |
| `nbCos` | cosine similarity between the candidate and the neighborhood centroid |
| `spec` | specificity measure of the candidate |
| `_confirmCount` | number of times the candidate has been confirmed across resource channels |
| `W_*` | weighting coefficients for each dimension |

One structural constraint: cross-disciplinary path harmony (N3) is counted here once only and must not be multiplied again at the outer layer. Historically, there existed a practice of "ranking at the inner layer multiplied by various outer-layer factors," which caused full-product-style collapse and was subsequently rejected.

### 3.4.3 Additive Aggregation (CombSUM)

The six-dimensional weighted aggregation is implemented verbatim as follows:

```javascript
const additive =
  CFG.W_SPATIAL * dSpatial +
  CFG.W_TF * dTf +
  CFG.W_PATH * dPath +
  CFG.W_NB * dNb +
  CFG.W_SPEC * dSpec +
  CFG.W_CONFIRM * dConfirm;
```

That is, a weighted linear sum (CombSUM as proposed by Fox & Shaw 1994), with no chain multiplication and no averaging. This is the direct realization of the design principle that "multi-dimensional annotation is a space, not a product."

### 3.4.4 Four Inhibition Dimensions (Additive Penalty)

Each inhibition gate first computes a multiplier `m ∈ (0,1]`, then converts it to an additive penalty `penalty_d = additive · (1 − m_d)`. Each gate appears only once here and does not constitute a legacy full-product chain.

| Inhibition gate | Trigger condition | Multiplier constant | Source level |
|----------------|-------------------|---------------------|--------------|
| mOverused (over-general) | hits the over-general penalty word list (130 manually annotated entries) or candidate carries an overused tag | `OVERUSED_PENALTY: 0.35` | experimentally calibrated locked value |
| mPolarity (polarity mismatch) | input is positive-valence but candidate is negative-valence (or vice versa) | `POLARITY_MISMATCH: 0.3` | experimentally calibrated locked value |
| mNbIrrelevant (irrelevant) | `nbCos < NB_IRRELEVANT_COS` (threshold 0.05) | `NB_IRRELEVANT_PEN: 0.15` | experimentally calibrated locked value |
| mIsolatedNoise (isolated noise) | requires resource confirmation but confirmation count is 0 | `ISOLATED_NOISE_PEN: 0.5` | experimentally calibrated locked value |

The final score implementation is verbatim as follows:

```javascript
const penaltySum = penOverused + penPolarity + penNbIrrelevant + penIsolatedNoise;  // each = additive·(1−m)
const blqScore = Math.max(additive * CFG.BLQ_SUPPRESS_FLOOR, additive - penaltySum);
```

**Variable definitions.**

| Symbol | Meaning | Source level |
|--------|---------|--------------|
| `m_d` | multiplier of the d-th inhibition gate, value in (0,1] | |
| `penalty_d` | additive penalty of the d-th inhibition gate, equal to `additive·(1−m_d)` | |
| `penaltySum` | sum of penalties from the four inhibition gates | |
| `BLQ_SUPPRESS_FLOOR` | soft floor coefficient, set to 0.1; multiple-gate stacked penalties do not hard-zero the result | experimentally calibrated locked value |
| `blqScore` | BLQ final score | |

Two properties of this design are worth noting. First, when a single gate triggers, `additive − additive·(1−m) = additive·m`, which is equivalent to the legacy single-gate chain multiplication; when multiple gates trigger, the result is linear stacked subtraction, with no exponential collapse. Second, the soft floor ensures that multiple stacked penalties do not hard-zero the result, embodying the soft-isolation principle under "broad tangential" operation. The system also provides a switch for the inhibition dimension aggregation mode; the default is additive mode, and multiplicative chain mode is retained only for reference experiments.

### 3.4.5 Redline Hard Removal (isRedlineWord)

Redline removal is hard removal: upon detection, the word is removed from the candidate pool and does not enter the output, rather than being down-weighted. The regular expression seeds for the four redline categories are structural constants, not tunable numerical values.

- **R1 Route words**: actions, methods, steps indicating "what should be done" (e.g., "建议" [suggest], "应该" [should], "方法" [method], "步骤" [step], "策略" [strategy], and English technique/strategy/step, etc.). The design principle is to give direction only, not routes.
- **R2 Inducement words**: leading language that makes judgments on behalf of the user (e.g., "你需要" [you need to], "你必须" [you must], "一定要" [must], "快去" [go now], and English you must/you need to, etc.).
- **R3 Subjective experience / expressing on behalf of the user**: expressions of the form "你（很/好/真/太/是/觉得/感到……）" [you (very/good/truly/too/are/feel/sense…)], "我觉得" [I think], "感觉很……" [feels very…]. The design principle is not to express on behalf of the user.
- **R4 Diagnostic words**: words that judge the user to have a disorder or pathological condition (e.g., "障碍" [disorder], "患者" [patient], "抑郁症" [depression], "焦虑症" [anxiety disorder], "确诊" [diagnosed], and English disorder/syndrome, etc.). The bare character "症" is excluded by "症(?!状)" to exclude "症状" [symptom], because "symptom" is description rather than diagnosis -- this refinement was discovered through white-box observation of actual outputs.

Over-general handling, quota, polarity, and Gaussian decay are all down-weighting operations (not removal); only R1–R4 constitute hard removal.

### 3.4.6 Differences Between Two-Level Fine-Ranking (node8 Filtering Information Words vs. node10 Filtering Direction Words)

The system sets up separate fine-ranking logic at two levels, with different functions.

| Dimension | node8 (information word filtering) | node10 (direction word filtering) |
|-----------|-------------------------------------|------------------------------------|
| BLQ scoring | runs full six-dimensional CombSUM | does not run six dimensions; only `node9 score × Gaussian decay` |
| Lateral inhibition | yes (neighborhood cosine above threshold → near-synonym detected and suppressed) | no |
| MMR diversity | yes (`λ·rel − (1−λ)·maxSim`, λ=0.7) | no |
| Quota | yes (per-axis quota 8, per-dimension quota 3; over-quota down-weighted) | no |
| Relevance decay | no (decay is inside BLQ inhibition dimensions) | Gaussian gradient `_gaussDecay(cos, PEAK=0.45, SIGMA=0.25, FLOOR=0.15)` (computes position, not suppression) |
| Cliff abstention | no | yes (cliff when preceding word is greater than succeeding word times cliff ratio 3 and sequence position is at least 5; breaks through the "fill 15 words" ceiling) |
| Output ceiling | 30 (information words) | 15 (direction words; contract is a string array of length 15) |
| Output redline | not applied (information words are not leaked to the main model) | redline annotated; hard removal executed by redline hard-removal component |
| Wiring status | component status (no production calls) | live active |

In one sentence: node8 is the "complete BLQ fine-ranking engine (six dimensions + lateral inhibition + MMR + quota)," currently in component status; node10 is "lightweight post-selection processing (Gaussian decay + redline annotation + cliff abstention)," currently live active. node10 does not reuse the full six-dimensional scoring, retaining only "decay" and "redline"; it does not usurp the role of many-to-one voting (node9) -- the order of many-to-one voting is primary, and node10 only performs down-weighting, decay, and redline handling.

### 3.4.7 Publicly Claimable Originality Scope

The three major components of the BLQ framework (CombSUM, MMR, and lateral inhibition) are all classical standard components; this system does not claim to have invented them. What may be claimed as original is limited to three points: first, the design argument that "additive is an OR gate, countering the AND gate of being negated by a single dimension in a multiplication chain"; second, the specific arrangement of the three-component set plus six additive dimensions plus four inhibition dimensions; third, the soft-floor soft-isolation mechanism. All weight coefficients, penalty coefficients, decay rates, and cutoff parameters are specific values calibrated through experiments or set as initial defaults; they are parameter details. When publishing, the structure takes precedence and specific values are not locked in.

### 3.4.8 Scoring Core Implementation Excerpt (Abridged)

The preceding sections described the structure of BLQ via per-dimension formulas and variable tables. This section supplements the continuous skeleton of the scoring core `calcBLQ`, to present the overall shape of "six additive dimensions one-pass CombSUM, then subtract several additive penalties, finally with soft floor as safety net" in the implementation. Excerpted from p1_node8_10_blq.mjs (abridged); the normalized expressions for each of the six additive dimensions are already given line by line in the table in Section 3.4.2; here only the aggregation and inhibition main trunk is retained, with white-box trace, polarity inference branches, and boundary fallbacks omitted:

```javascript
// ── Six additive dimensions weighted CombSUM (additive aggregation, no chain multiplication, no averaging) ──
const additive =
  CFG.W_SPATIAL * dSpatial + CFG.W_TF * dTf + CFG.W_PATH * dPath +
  CFG.W_NB * dNb + CFG.W_SPEC * dSpec + CFG.W_CONFIRM * dConfirm;
// ── Four inhibition dimensions: each gate computes multiplier m∈(0,1] first, then converts to additive penalty = additive·(1−m) (each gate once only) ──
const penOverused      = additive * (1 - mOverused);
const penPolarity      = additive * (1 - mPolarity);
const penNbIrrelevant  = additive * (1 - mNbIrrelevant);
const penIsolatedNoise = additive * (1 - mIsolatedNoise);
const penaltySum = penOverused + penPolarity + penNbIrrelevant + penIsolatedNoise;
// ── Soft floor: multiple stacked penalties do not hard-zero (soft isolation) ──
const blqScore = Math.max(additive * CFG.BLQ_SUPPRESS_FLOOR, additive - penaltySum);
```

The weights `W_*`, the four penalty multiplier constants, and the soft floor coefficient `BLQ_SUPPRESS_FLOOR` are all experimentally calibrated locked values, retained here as symbols without locking specific values. This skeleton verbatim confirms the two main formulas from Sections 3.4.3 and 3.4.4: the additive dimensions use addition (`additive` is a pure weighted sum); the inhibition dimensions use "multiplier converted to additive penalty" (`penalty = additive·(1−m)`); when a single gate triggers, this is equivalent to the legacy single-gate chain multiplication `additive·m`; when multiple gates trigger, the result is linear stacked subtraction rather than exponential collapse.

Node 10's lightweight direction word fine-ranking does not reuse the above six-dimensional scoring; it uses Gaussian decay instead (corresponding to "computing position rather than suppression" in Section 3.4.6). Its core function excerpt is as follows (from p1_node8_10_blq.mjs, abridged):

```javascript
function _gaussDecay(cos, peak, sigma, floor) {   // landing in optimal band → ~1.0; deviation → gradual decrease to floor (not zeroed)
  if (cos == null) return 1.0;
  const g = Math.exp(-((cos - peak) ** 2) / (2 * sigma * sigma));
  return floor + (1 - floor) * g;
}
```

`peak/sigma/floor` are the optimal band center, bandwidth, and lower bound for this function (experimentally calibrated locked values, represented by symbols here). The structure `floor + (1-floor)·g` ensures that even at maximum distance the result is not zeroed -- this is the same "soft isolation" principle as the soft floor in the BLQ main framework, realized a second time at a different level.

## 3.5 Ablation and Failed Proposals

This section records, in the format of "ablation and failed proposals," proposals that were empirically disproved during algorithm evolution. Negative evidence has independent value in a technical report: it marks which directions that "appeared more reasonable" in the design space have been empirically ruled out, so that subsequent work does not repeat the same mistakes. Most formulas listed in this section are historical proposals, not the current implementation; readers should not treat them as current system behavior.

### 3.5.1 Three Generations of Scoring Formula Evolution

**First generation: thirteen-factor product (deprecated, listed as a cautionary example).**

Early (2026-05-05 version) contraction scoring used the full product of thirteen factors:

```
finalScore = vote^1.2
           × dynamicPE          × ibApprox         × crossFaceBonus
           × valCoh             × nbBoost          × dimOverlapPenalty
           × stageBoost         × routeBoost       × crossoverBoost
           × memAnchorBoost     × registerBoost    × modeDirBoost
```

It was judged a cautionary example for three reasons: first, the full product of thirteen factors is equivalent to an AND gate -- any factor that is low causes global collapse; second, the factors are not mutually independent (e.g., the vote term and the cross term are highly correlated), violating the independence assumption required by the naive Bayes product; third, several factors had individual definitional flaws, such as the dynamic surprise measure having cross-user contamination, a weighting term artificially inflating votes, and the dimension-overlap penalty `0.55^(dims-2)` eliminating hub words, which is contrary to the design orientation of "small words activating large modules."

**Second generation: axis average (rewritten).**

This was subsequently changed to the mean of 14-dimensional coordinate dot products, breaking 4.0 for the first time (4.050):

```
score = Σ[(coordAccum[i] × termCoords[i]) / max(|coordAccum[i]|, 0.5)] / 14
```

This approach corresponded to the early idea that "over-general words arise mainly because certain axis scores are too high, so averaging should be applied," but taking the mean was subsequently rejected: averaging zeroed out the tension between dimensions, causing over-general words to increase by approximately 25%. This led to the evolution to the third-generation additive voting.

**Third generation: weighted linear / additive voting (current direction).**

On the recall side, the current approach uses a weighted linear combination:

```
composite = 0.45×relevance + 0.20×recency + 0.20×attention + 0.15×weight
```

The weight coefficients are experimentally calibrated locked values. This approach is the only algorithm simplification approved under the redline of "do not simplify," because it is an enhancement rather than a regression. Empirical tests showed this direction brings significant gains across multiple datasets. The corresponding redlines include: no reverting to the product (the product approach was empirically shown to cause a large drop in recall rate), no removing softmax normalization, and the specific weight values may be adjusted while the "weighted linear direction" itself is locked.

The system also retains a legacy multiplicative single-node scoring for debugging use:

```javascript
ebbinghaus = record.freq × (1 / (1 + days × 0.1));            // Ebbinghaus forgetting curve
importance = record.weight × Math.max(0, 1 - days / 60);      // completely fades after 60 days
axisOverlap = Σ cosineSim(qVec, kVec) / |axes|;               // multi-axis projection alignment (normalized)
spreadDecay = Math.pow(0.6, spreadDistance);                  // 0/1/2/3 → 1.0/0.6/0.36/0.216
scorePerNode = ebbinghaus × importance × axisOverlap × spreadDecay;
scoreRecord = max(scorePerNode)  // max-pool: a memory with one dimension being very strong triggers recall
```

And a three-factor confidence measure for gate determination (not participating in ranking):

```
confidence = 0.5×max(score) + 0.3×(hit_count/2 clamp[0,1]) + 0.2×axis_consistency
gate threshold: chat/airp 0.5 / game 0.6 / work/bot 0.7 / code·memory: divergence not run
```

The three-factor weights and gate thresholds above are all experimentally calibrated locked values.

### 3.5.2 Nineteen-Path Spreading Activation Table (Historical Snapshot)

The second-generation divergence phase was configured with nineteen spreading activation paths, each with a path quality weight (higher is better). This is a historical snapshot; the specific behavior of certain paths has been refactored in subsequent migrations.

| # | Path | Core | Path quality |
|---|------|------|-------------|
| 0 | direct | n-gram direct word | SKIP |
| 1 | chatContext | historical supplement | SKIP |
| 2 | recallAnchor | memory file retrieval | SKIP |
| 3 | memoryDiverge | SWOW re-divergence when recall > 0 | 1.3 |
| 4 | memoryTechDiverge | recall + technical attention ≥ 2.0 | 1.6 (highest) |
| 5 | cooccur | inverted index | 1.5 |
| 6 | analogy | Cilin analogy (distance 4–5) | 0.5 |
| 7 | emotionAxis | emotion axis | 1.3 |
| 8–9 | swowLocated | neighborhood centroid + single word | 1.4 |
| 10 | airpTechnique | work-to-technique mapping | 1.0 |
| 11 | techDiverge | technical word divergence | 1.5 |
| 12 | cilinDiverge | Cilin hierarchy | 1.4 |
| 13 | contrast | antonym mapping (227 pairs) | 1.2 |
| 14 | axisDiverge | domain lexicon neighborhood cosine | 1.5 |
| 15 | numberbatch | word-vector far end | 0.6 |
| 16 | bridge | word-vector bridging | 0.7 |
| 17 | centroid | centroid projection | 0.7 |
| 18 | analogy_struct | structural analogy (A:B::C:?) | 0.6 |
| 19 | hopDiverge | two-step word-vector hop | 0.5 |

This table has a known deficiency: for performance reasons, paths 15–19 are skipped when the near-end candidate count is ≥ 30; because Chinese-language scenarios almost invariably trigger short-circuiting when word count ≥ 5, the high-quality "flash of inspiration" far-end paths are frequently cut. In addition, swowLocated's five-factor scoring `score = (dimScore×0.4 + novelty×0.6) × (0.3 + 0.7×anchorAttn) × sixDegreeBonus × weakTieBonus` has a known deficiency: anchor attention only counts literally shared Chinese characters, so it is nearly always zero in English-language scenarios.

### 3.5.3 Confidence Routing (Historical; Manually Tuned Thresholds Without Statistical Basis)

The early confidence routing was as follows:

```
confidence = F1×0.45 + F2×0.35 + F3×0.20    (F1 richness / F2 score gap / F3 history)
≥0.55       → normal (6 words)
0.30-0.55   → multi_candidate (10 words)
<0.30       → meta_signal (0 words, silent)
```

The thresholds 0.55/0.30 were manually tuned, lacking a statistical basis, and are classified as initial default values; the plan is to replace them with Conformal Prediction-style methods.

### 3.5.4 Distance Band for Far Associative Links (Current Reference)

The system uses a "sweet zone" distance band to control how far divergence reaches, as the current reference:

```
semDist < 0.15 → blq × 0.4   (too close, synonym redundancy)
semDist < 0.25 → blq × 0.7
semDist > 0.80 → blq × 0.5   (too far, random noise)
semDist > 0.70 → blq × 0.8
```

The sweet zone is `0.15 < semDist < 0.80`, where the decay coefficients are experimentally calibrated locked values. A related redline is: distance-1 synonym spreading was empirically shown to cause significant drops in recall rate and ranking metrics; hence "analogy is cross-domain isomorphism; synonym spreading is not performed" has been listed as a redline.

### 3.5.5 Complete Cognitive Activation Equation (Not Implemented)

The system had planned a complete ACT-R activation equation, but currently only the fan-out penalty term has been wired in; the base activation and spreading activation portions are not implemented:

```
base activation:     B_i = ln(Σ_j t_j^{-d})            d = 0.5 (decay rate)         ← not implemented
spreading activation: S_ji = S - ln(fan_j)              S = 2.0 (max association strength) ← not implemented
                      W_j = 1.0 / len(context_chunks)                                 ← not implemented
full equation:        A_i = B_i + Σ_j(W_j × S_ji) + ε_i  ε = 0.5 (noise)            ← not implemented
retrieval threshold:  τ = -2.0    latency: T = 0.35 × e^{-A_i}
```

Currently implemented is only the fan-out penalty `fanPenalty = 0.015 × log(fan(term))` (corresponding to ACT-R's fan-out effect, Anderson 1974); approximately fifty lines of the complete activation equation are not wired. The decay rate, maximum association strength, noise, retrieval threshold, and other parameters are all initial default values in the planning stage.

### 3.5.6 Scoring Trajectory (Algorithm History Milestones)

The trajectory of system scoring across versions is as follows, viewable as a milestone sequence in algorithm history:

```
v9   2.010  baseline
v18  2.960  lexiconization
v21  3.690  vocabulary expansion
v26  4.050  first break above 4 (axis-average algorithm)
v27  4.040  large–medium–small routing
v37~38 3.x  K bridging / surprise / transfer index iteration
v39  2.000  total collapse (transfer index batch injection fan-out explosion + English scenario failure)
v40  3.83   rebuild + front-end terminology + small model integration
v41b 3.93   current (XML prompt + post-logic correction + meta-signal fallback)
```

The root cause of the v39 collapse was transfer index batch injection triggering fan-out explosion (e.g., one abstract academic entry corresponding to 45 terms plus 2,709 cognitive mechanism words generated approximately 120,000 injections, with 12 terms covering 66% of triggers); v40 rebuilt from an early version and applied a 15% hard ceiling to fix it. It should be noted that the scores above are internal evaluation scores; the calibrated score under a strict 200-case, five-dimensional evaluation is approximately 0.72, which is the most credible evaluation calibration -- rule-based self-evaluation has a systemic positive bias.

### 3.5.7 Historical Unified Formula Design Draft (Multiplicative Version, Not Current Implementation)

During evolution, a seven-factor unified formula design draft emerged in multiplicative form:

```
F(w) = Activation(w) × IB-tradeoff(w) × (1+λ·Sys(w))
     × LogicScore(w) × PathHarmony(w) × NoveltyBonus(w) × Σαₐ·scoreₐ(w)
```

Where each term is defined as: activation `A(w) = A₀·∏[γ·wₖ·I_disc(k)]` (γ is 0.7–0.85, chain length K ≤ 3, disciplinary switch indicator I_disc is 1 when crossing disciplines and 0.5 within the same discipline; activation stops below 0.15); information bottleneck tradeoff `Score(w) = d(w)/(1+α·d(w)²)`, optimal distance `d* = 1/√α` (inverted U-shape, intermediate values optimal); structural mapping `Sys = 0.5·H(higher-order relations) + 0.3·R(first-order) + 0·A(attributes not scored)`; path harmony `log(1+number of distinct disciplines) × coherence`, where coherence equals `1 − (switch count − discipline count)/total steps`; novelty `1/√(historical_count+1)` (simplified upper confidence bound).

It must be emphasized: this design draft is the seven-factor multiplicative version, different from the additive CombSUM version currently implemented in Section 3.4. It is an intermediate state in the evolution that was superseded by the argument "additive is superior to multiplicative," and is not the current implementation.

### 3.5.8 List of Deprecated/Disproved Proposals

The following proposals have all been empirically disproved or deprecated and should not be repeated: raising the boost ceiling from +0.3 to +0.05 caused total zeroing; changing the vote exponent from 1.2 to 1.0 was a regression; replacing maxAbs with tanh was a regression; replacing with VAD three-value direct substitution was a regression; distance-1 synonym spreading caused a significant regression; online learning approach exhibited training oscillation; the HyDE online version violates the 0-token principle and was rejected; the paid routing approach was rejected; the Cilin encoding distance analogy approach (outputs become highly homogeneous); soft-weight mode routing (mode vectors too similar); generating associative data with an external model (violates redlines; deleted); co-occurrence stop-word list approach was a regression; never-used lazy-binding dead code.

## 3.6 Related Work Comparison

This section consolidates all related work comparisons. The tier definitions are given first, followed by positioning tables for the algorithm line and framework line, and finally a list of borrowed sources. Tiers only state factual levels of mechanical similarity and chronological order; no final ruling on priority of invention is included.

### 3.6.1 Tier Definitions

- **Tier A**: mechanism highly similar, and publicly available before this system's design period (2026-04) -- possible collision.
- **Tier B**: partially similar, i.e., component or conceptual overlap, but overall mechanism or purpose differs.
- **Tier C**: conceptual terms only similar, i.e., terminology naming collision but mechanisms do not match.
- **Tier D**: no similar public work found.

### 3.6.2 Algorithm Line Comparison Table

| # | Original item | Closest public work | That work's date | Before 2026-04 | Tier | Collision level |
|---|---------------|---------------------|-----------------|:-:|:-:|----------------|
| 1 | Three-phase mechanism | CreativeDC / Scaffolding Creativity | 2025-12 / 2025-10 | Yes | B | conceptual level |
| 2 | Spatial voting (IDW+temperature) | IDW(1968) / semantic ranking patents | 1968 / 2018-21 | Yes | C→B | component level |
| 3 | Hough many-to-one | Hough / VoteNet | 1962 / 2019 | Yes | C (transfer D) | paradigm naming collision |
| 4 | Two-round divergence architecture | no independent hit; nearest ToT | — | — | D | — |
| 5 | Six-axis plane divergence | Biber MDA / LIWC | 1988 / 2001 | Yes | C | numerical/conceptual naming collision |
| 6 | Sub-axis activation positioning | Axis-Aligned BO / neuron polysemanticity | 2025-04/05 | Parallel | D (neighbor C) | — |
| 7 | Bracket dual channel | User-Stream Routing / narrative tension | 2026-05/04 | After/parallel | C | conceptual naming collision |
| 8 | Broad tangential recall | HippoRAG / SYNAPSE / mem0 | 2024-05 / 2026-01 | Yes | B | means level (purpose opposite) |
| 9 | QKV pool convergence divergence | attention as retrieval / CSAttention | 2017+ / 2026-04 | Yes/parallel | C | conceptual analogy naming collision |
| 10 | Large–medium–small three-level routing | HRR / coarse-to-fine / CITADEL | 2025-03 / 2022 | Yes | B | structural level (hub-addressing motivation not colliding) |
| 11 | Hot-swappable lexicon = divergence axis | ES dictionary hot-loading / ST World Info | 2020-11 / 2023 | Yes | C | infrastructure naming collision |
| 12 | Two-level vocabulary + null-word criterion | Seeding priming / Inner Lexicon | 2023-24 | Yes | C→D | loose conceptual collision |
| 13 | BLQ multi-dimensional additive | CombSUM/MMR/lateral inhibition/SYNAPSE | 1994-1998 / 2026-01 | Yes | B | component level |
| +1 | 0-token white-box stance | SA-RAG/FS-RAG/LWOW/MAD | — | — | D | competitive landscape (sole 0-token) |

**Algorithm line tier statistics**: A=0; B=5 (items 1, 8, 10, 13, and item 2 leaning B); C=6; D appears in specific mechanisms, transfers, or combination layers across multiple items.

### 3.6.3 Items Requiring Manual Review

Three items with relatively high similarity are listed as priorities for manual review.

First, SYNAPSE (arXiv 2601.02744, 2026-01, predating this system) shares the three terms "spreading activation," "lateral inhibition," and "fan-out effect" with "broad tangential recall," but the uses are orthogonal (retrieval question-answering accuracy vs. divergent generation); a deeper implementation-level collision cannot be ruled out from the abstract alone; the full text needs to be reviewed to confirm.

Second, a hot/warm/cold three-layer memory structure (arXiv 2603.00037, 2026-03-18) not only shares the name but also uses physical file directories for layering in the same way and similarly employs date-named logs; the starting time of this system's three-layer design according to project records is earlier by about a few days, but the margin is only a few days and the mechanisms are highly similar -- this is the item with the highest similarity and requires review of project records to confirm independent parallel invention.

Third, some variable update and template engine capabilities in this system are migrated from the SillyTavern ecosystem (e.g., the variable update mechanism and prompt template engine); when publishing, the corresponding upstream projects must be credited; this system's original extensions on top of those are limited to the orchestration of execution dependency chains and server-side integration.

### 3.6.4 List of Borrowed Sources

The system drew on classical work from multiple fields in its design. In cognitive science and bionics, implemented borrowings include: spreading activation (Collins & Loftus 1975) corresponding to multi-path spreading activation; fan-out effect (ACT-R, Anderson 1974) corresponding to fan-out penalty; pattern separation/completion (hippocampus) corresponding to the three-layer memory repository; Complementary Learning Systems theory (McClelland 1995) corresponding to the dual structure of recall and spreading activation; the information bottleneck inverted U-shape (Tishby 1999) corresponding to the information bottleneck approximation; surprise modulation (Pearce-Hall 1980) corresponding to frequency decay; weak ties theory (Granovetter 1973) corresponding to bridging paths; structure mapping engine (Gentner 1983) corresponding to structural analogy; script/frame theory (Schank 1977) corresponding to frame patterns; systemic functional linguistics (Halliday 1994) corresponding to function word handling; attachment theory (Mikulincer-Shaver) corresponding to character psychology channels.

In information retrieval and machine learning, implemented borrowings include: CSLS geometric correction (Lample 2018), MMR diversity (Carbonell 1998), inverse document frequency (Spärck Jones 1972), Numberbatch word vectors (Speer & Lowry-Duda 2017), scaled dot-product attention (Vaswani 2017), SWOW associative data (De Deyne 2019), BM25 (Robertson 1994), CombSUM (Fox & Shaw 1994), and others.

Planned but not yet implemented borrowings include: HippoRAG (Gutiérrez, NeurIPS 2024, arXiv 2405.14831) and its sequel (ICML 2025, arXiv 2502.14802) for personalized PageRank retrieval; Reciprocal Rank Fusion (Cormack 2009) for cross-scale fusion; LambdaMART (Burges 2010) as a replacement for manually tuned factors; Conformal Prediction routing (Su 2025) as a replacement for manually tuned thresholds; offline HyDE (Gao 2023; online version rejected for violating the 0-token principle); and evaluation calibration methods PPI (Angelopoulos 2023) and multi-judge (Verga 2024). Additionally, in terms of cross-disciplinary analogies, each component of the system can be placed in isomorphic relationship with principal component analysis, statistical-physics ensemble averaging, Boltzmann distribution, spotlight attention, the Condorcet theorem, PageRank random walks, information bottleneck, and channel coding.

### 3.6.5 Global Fact-Level Summary

Taken together, the following fact-level conclusions can be drawn. First, no item in the algorithm line collides in the sense of "mechanism highly similar and before 2026-04" (A=0); in the framework/system line, only the three-layer memory is highly similar (a few days apart, same name plus physical files). Second, this system's originality claims generally fall at the "assembly/transfer/design argument" level, not at the level of any single component -- the individual components involved (inverse-distance weighting, Hough voting, CombSUM, MMR, lateral inhibition, spreading activation, coarse-to-fine routing, hot-loading lexicons, etc.) are mostly mature technologies from the 1990s to 2020s, and this system does not claim to have invented them; what has not been found in public work is "assembling them into an add-on pipeline serving divergence" and several specific criteria and transfers (Hough transferred to direction word generation, bracket dual channel, null-word criterion, lexicon file as divergence axis, the AND-gate argument for additive countering multiplicative). Third, the three high-similarity items noted above require manual review.

## 3.7 Summary

This chapter formally described the algorithm design of the self-driven divergence and recall system. The core can be summarized across three levels. At the mechanism level, the system is externally attached to the large language model via a "contraction–divergence–contraction" three-phase structure; through two rounds of heterogeneous divergence, six-axis plane parallelism, spatial additive voting, and many-to-one aggregation, isolated associative points are converted into direction words available for the main model. At the scoring level, the BLQ framework uses weighted CombSUM additive scoring to counter multiplicative chain single-dimension negation, supplemented by lateral inhibition, MMR quota, soft floor, and redline hard removal, forming a complete and white-box-readable candidate quality device; the information word fine-ranking engine is currently in component status, while the direction word lightweight fine-ranking is live active. At the principle level, the full pipeline adheres to the 0-token white-box stance, not calling any large language model for a single divergence step.

From the related work comparison perspective, the individual algorithmic components used by the system are mostly mature technologies; the system's originality claims fall at the three levels of assembly, transfer, and design argument. Item-by-item verification did not reveal any collision in the sense of "mechanism highly similar and before the design period"; only several high-similarity items require further manual review. Failed proposals disproved during evolution -- represented by the thirteen-factor product, axis average, and multiplicative unified formula -- collectively support the current design orientation of "additive is superior to multiplicative, soft isolation is superior to hard zeroing," forming the negative evidence foundation of this system's algorithm design.

---

## 3.8 Production Implementation Overview (2026-08-02)

This section describes the live algorithm implementation for end users.

### What We Use

| Resource | Purpose | Data |
|----------|---------|------|
| **SWOW-ZH/EN** | Free association network: input word → human first-reaction associations | ZH 83K pairs / EN 12K pairs |
| **ConceptNet** | Knowledge graph: 14 relation types (cause/use/property/part-of...) | ZH 22MB / EN 128MB |
| **HIT-IR Cilin** | Chinese synonym thesaurus: semantic expansion by category | Extended edition |
| **NumberBatch 300** | Word vectors: 824K words, int8 quantized | 236MB (mmap, not fully loaded) |
| **WordNet** | English word sense network: path similarity cross-validation | NLTK built-in |
| **BCC Frequency** | Dialog + general corpus word frequency: filters ultra-high-frequency function words | 6.6MB |
| **ONNX ELECTRA** | POS tagging: CTB9 tagset, auto GPU/CPU | 47MB model |
| **Gigatoken** | LLM tokenizer (Qwen3-8B): phrase-level matching as second perspective | Rust native |

### What Is the BLQ Algorithm

BLQ (Bilu Quality) is the candidate quality scoring framework. It doesn't choose directions — it eliminates noise and quantifies each candidate word's quality score.

<details>
<summary><b>BLQ Formula (click to expand)</b></summary>

Core formula:

```
F(w) = Vote(w)^α × IB(w) × LogicScore(w) × NoveltyBonus(w)
```

Four factors multiplied — each evaluates candidate quality from a different angle:

| Factor | Meaning | Formula |
|--------|---------|---------|
| **Vote^α** | How many independent divergence mechanisms found this word (resonance) | `max(1, resonance)^1.2` |
| **IB** | Information Bottleneck: inverted-U curve of vector distance (too close = synonym redundancy, too far = irrelevant noise) | `d / (1 + α·d²)` |
| **LogicScore** | Logic score: max of deductive/inductive/abductive/contrastive dimensions derived from ConceptNet relations | `max{deductive, inductive, abductive, contrastive}` |
| **NoveltyBonus** | Freshness: words used more often score lower (prevents the same batch from dominating) | `1 / √(usage_count + 1)` |

Redline parameter: `α = 1.2` (Vote exponent) — changing to 1.0 causes regression (A01 evidence), forbidden to modify.

Goldilocks four-segment (NB300 cosine distance segmented weights):

```
cos < 0.15  → drop (too far = irrelevant)
cos < 0.25  → ×0.7 (distant)
0.25 ≤ cos ≤ 0.70 → ×1.0 (sweet spot)
0.70 < cos ≤ 0.80 → ×0.8 (close)
cos > 0.80  → ×0.5 (too close = synonym redundancy)
```

</details>

### Three-Layer Filtering

User input passes through three gates, each eliminating a batch of noise:

```
① Tokenization Filter (node1)
   Input text → jieba+HanLP tokenize → stopwords/BCC high-freq/concreteness/POS 4-layer filter
   Kept: nouns, OOV proper nouns, English NOUN/PROPN
   Dropped: function words, ultra-high-frequency verbs, low-concreteness abstract words

② Divergence + Second-pass Filter (node2)
   Kept words → SWOW+ConceptNet+Cilin 3-mechanism parallel diverge → pool
   Second-pass: verbs/function words/BCC ultra-high-freq in divergence output re-filtered
   Output: candidate pool (sorted by resonance, ≥2 mechanisms hit = high confidence)

③ Triple Review (node3)
   Pool → BLQ pre-filter (Vote×Logic×Novelty, no vector service needed)
       → surviving words sent to NB300 cosine verification (Goldilocks segments)
       → WordNet dual verification (English words: both NB+WN must pass threshold)
       → BLQ final filter (full four-factor score below threshold → drop)
   Output: quality-certified candidate words
```

### How Ranking Works

Candidates surviving all three filters are matched against each memory record:

```
④ Hybrid Ranking (node4)
   BM25 term frequency matching (classic IR algorithm)
   + Association word hit bonus (divergence output word appears in memory = bonus)
   + Phrase consecutive match bonus (LLM token granularity, ≥3 consecutive tokens = phrase match)
   + Layer weight (hot/warm/cold memory layers with different weights)
   + Recency decay (recent memories rank higher, formula: 0.995^hours_since_now)
   = Final score → sort by score → take top-K records → inject into AI context
```
