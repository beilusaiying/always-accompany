# Chapter 5 BLQ Scoring and the Output System

> This chapter describes the complete chain by which the P1 pipeline converges from the "information word pool" to the "final direction-word output." At its core is the BLQ scoring algorithm — a quality-ranking apparatus restructured from a fully multiplicative formula into additive CombSUM — which, together with Hough many-to-one voting (Node-9) and red-line filtering (Node-10), completes the final convergence. In addition, this chapter covers two supporting modules, tokenization preprocessing (Node-1) and the axis system (six primary axes + 47 sub-axes), which jointly form the coordinate-localization foundation for information words in the multi-disciplinary space.

## 5.1 The BLQ Algorithm

### 5.1.1 Name Origin and Design Positioning

BLQ stands for **Beilu Linqing Quality**, taken from the project name "beilu" and the initials of the core designer Linqing. It is the core ranking algorithm of P1's Contraction-2 stage, responsible for quality filtering and ranking of the information word pool.

In terms of module responsibility, the system established the principle of separating localization from scoring: the 47-sub-axis system undertakes only spatial coordinate localization (determining which sub-directions are activated), while quality ranking is performed independently by BLQ and the vector-similarity module. This Separation of Concerns design prevents mutual contamination between the localization signal and the quality signal. BLQ is a **scoring apparatus, not a divergence engine**. It receives information words that upstream nodes have already localized and diverged, performs multi-dimensional quality assessment on them, and produces ranking results for the final output stage to consume.

### 5.1.2 Evolution from Multiplicative to Additive

The formula shape of BLQ underwent one fundamental restructuring. The early version used a full-product formula:

```
blqScore = gate * rank * bonus
```

where `_rank` was itself internally a weighted product of 8 signals. This multiplicative form suffers from a severe **exponential collapse problem**: when an information word scores low on one factor (for example, a factor value of 0.3), the product of several factors drops exponentially. Taking 4 factors each at 0.3 as an example:

$$0.3^4 \approx 0.008$$

An information word that performs well on most dimensions is pressed to near zero merely because of a low score on a single dimension — equivalent to an AND logic gate: if any factor approaches zero, the whole approaches zero.

This contradicts the system's design semantics of "multi-axis resonance reward" (OR logic: hitting several dimensions suffices to qualify). The algorithm-efficiency review (Expert_algorithm) characterized this problem as the "short-circuit effect" of product scoring: any factor approaching zero drives the whole toward zero, equivalent to an AND gate, in direct conflict with the OR semantics required by multi-axis resonance.

The solution was to restructure BLQ into the **additive CombSUM** (Combinatorial Sum) form. CombSUM is a classic multi-source fusion method in information retrieval (Fox & Shaw, 1994); its core idea is to directly sum the scores of multiple independent ranking signals rather than multiply them. This preserves each dimension's independent contribution and avoids the exponential collapse caused by chained multiplication.

### 5.1.3 Full Formula Expansion

The restructured calcBLQ function (located in the BLQ module) adopts an additive architecture of "6 bonus dimensions + 4 suppression dimensions."

#### The 6 Bonus Dimensions (additive base score)

The bonus dimensions compute the base score by weighted summation:

```
additive = W_SPATIAL * spatial + W_TF * tf + W_PATH * pathHarmony
         + W_NB * nb + W_SPEC * spec + W_CONFIRM * confirmLog
```

Table 5-1 shows the weight, computation method, and academic source of the 6 bonus dimensions.

**Table 5-1: The 6 BLQ Bonus Dimensions in Detail**

| Dimension | Weight | Computation method | Academic source |
|------|------|---------|---------|
| `spatial` | W_SPATIAL = 1.0 | Spatial-voting score (totalVote written back by node6) | Hough Transform (Hough, 1962) |
| `tf` | W_TF = 0.6 | BM25 TF saturation function: `tf = f*(k1+1) / (f + k1*(1-b+b*|d|/avgdl))`, k1=1.5, b=0.75 | BM25 (Robertson et al., 1994) |
| `pathHarmony` | W_PATH = 0.4 | Path harmony (disciplinary consistency of divergence paths) | Custom metric |
| `nb` | W_NB = 0.5 | Numberbatch 300-dimensional cosine similarity | ConceptNet Numberbatch (Speer et al., 2017) |
| `spec` | W_SPEC = 0.4 | Term specificity (IDF discriminativeness) | TF-IDF (Salton & Buckley, 1988) |
| `confirmLog` | W_CONFIRM = 0.3 | Logarithmic normalization of confirmCount: `log(1 + confirmCount)`, a multi-route resource-confirmation signal | Custom metric |

The BM25 TF saturation function is the standard document-frequency saturation formula in information retrieval, introducing the two parameters k1 and b to control the speed of term-frequency saturation and document-length normalization.

In the P1 context, a "document" corresponds to the number of times an information word is hit across multiple spatial-voting channels; the saturation function drives the score growth of frequently hit words toward saturation, preventing them from occupying the top of the ranking indefinitely.

#### The 4 Suppression Dimensions (additive deductions)

The suppression dimensions use additive deductions rather than chained multiplication, ensuring that stacked gates do not collapse exponentially. Table 5-2 shows the deduction amount, trigger condition, and design notes of the 4 suppression dimensions.

**Table 5-2: The 4 BLQ Suppression Dimensions in Detail**

| Suppression dimension | Deduction | Trigger condition | Notes |
|--------|--------|---------|------|
| `overused` (over-generic-term list) | 0.35 | The term appears in the `overused_penalty.json` list (129 entries) | Words activated in 80%+ of distinct inputs |
| `polarity_mismatch` (polarity mismatch) | 0.30 | The information word's polarity is inconsistent with the input polarity | E.g., the input is negative but the word is positive |
| `nb_irrelevant` (semantically irrelevant) | 0.15 | NB300 cosine similarity < 0.05 | Semantically too distant from the input centroid |
| `isolated_noise` (isolated noise) | via 0.50 | confirmCount = 0, no resource confirmation of any kind | An isolated word not cross-validated by multiple resource routes |

The final BLQ score is computed as:

```
blqScore = max(additive * BLQ_SUPPRESS_FLOOR, additive - SUM(penalties))
```

where `BLQ_SUPPRESS_FLOOR = 0.1` is the soft floor — even after multiple stacked deductions, a 10% lower bound of the base score is retained rather than hard-zeroing. This corresponds to the system's established soft-filtering design principle ("high volume, broad recall"): even if a word is hit by several suppression gates, it is not eliminated entirely but retained at a low score after heavy down-weighting, avoiding the irreversible signal loss caused by hard thresholds.

### 5.1.4 Core Code

The calcBLQ function resides in the BLQ module and is imported and invoked by the Transfer module under the alias `_calcBLQ_n8`.

The core implementation pattern of the additive architecture is as follows (using the node9 direction-word quality gate as the example; node8 calcBLQ adopts exactly the same additive form):

```javascript
// Node-9 direction-word selection module — additive-deduction helper
const _pen = (m, label) => {
  if (m >= 1) return; // m=1 means no deduction (= not triggered)
  const penalty = _score0 * (1 - m);
  _gates.push({ gate: label, factor: +m.toFixed(3), penalty: +penalty.toFixed(4) });
};

// Aggregation + soft floor (Node-9 direction-word selection module)
if (_gates.length > 0) {
  const _penSum = _gates.reduce((s, g) => s + g.penalty, 0);
  dw.score = Math.max(_score0 * GATE_SUPPRESS_FLOOR, _score0 - _penSum);
}
```

The code segment above embodies the three hard rules of the additive rewrite:
1. **Each gate converts its multiplier m into one additive deduction** `penalty = score * (1 - m)`; each gate deducts once, and gates do not amplify one another;
2. **Chained multiplication is forbidden**: the single-gate deduction `score - score*(1-m) = score*m` is equivalent to the old single-gate multiplication, but multiple gates now stack linearly rather than collapsing exponentially;
3. **The soft floor prevents zeroing**: `max(score * FLOOR, score - SUM)` guarantees that at least 10% of the base score is retained.

### 5.1.5 Rejection Record

During the evolution of the BLQ formula, several alternative schemes were rejected by experiment. Table 5-3 summarizes their experimental results and rejection reasons.

**Table 5-3: Rejection Record of BLQ Alternative Schemes**

| Scheme | Experimental result | Rejection reason |
|------|---------|---------|
| Geometric mean | lccc +25% degradation | The geometric mean is still in the multiplicative family and is sensitive to zero values |
| Product rollback (the old full-product formula) | lccc -62% | Exponential collapse (the 0.3^4 problem); AND-gate logic contradicts multi-axis resonance |
| cos-mu contrast applied in three places | Counterproductive: obscure low-mu words newly entered the top of the output | A symptom-level patch; the true root cause was node6 not being wired back into the primary ranking (removed in its entirety on 2026-06-02) |

At the level of scheme rejection, the system established the engineering discipline of "no symptom-level patches": any modification that conflicts with the additive-architecture principle is removed in its entirety once identified, rather than having further corrective terms stacked on top — patch stacking locks the error into the symptom layer and continuously degrades the architecture. The wholesale removal of the cos-mu contrast scheme in Table 5-3 (2026-06-02) is an executed instance of this discipline.

---

## 5.2 Hough Many-to-One Voting (Node-9)

### 5.2.1 Academic Source

The core algorithm of Node-9 is inspired by the **Hough Transform** (Hough, 1962), a classic computer-vision method for detecting lines and other geometric shapes from scattered points. The essence of the Hough transform is "many-to-one voting": each scattered point votes in the parameter space, and only parameter combinations jointly pointed to by a large number of scattered points can qualify.

P1 transfers this idea into semantic space. Table 5-4 shows the correspondence between the original concepts of the Hough Transform and the transferred implementation in P1 Node-9.

**Table 5-4: Concept Transfer from the Hough Transform to Node-9**

| Hough Transform (original) | P1 Node-9 (transferred) |
|------------------------|-------------------|
| Scattered points | Each information word in the information word pool |
| Candidates in the parameter space | Eligible terms in AT (Activation Terms) |
| Voting | 47D cosine range gate + NB300 semantic-similarity scoring |
| The parameters hit by the most scattered points = the detected shape | The term jointly pointed to by the most information words = the direction word |

### 5.2.2 Algorithm in Detail

#### Design Principles

The system established three design constraints on voting semantics: first, the voting direction is many-to-one — multiple information words jointly point to one direction word, rather than a single information word diverging into multiple direction words; second, the diverging subject is the information pool as a whole, not individual words — per-word divergence followed by summation naturally favors highly connected generic words; third, aggregation does not take averages and preserves distributional tension — centroidization would collapse the distribution into a single point, losing multi-peak information.

These three constraints respectively reject three erroneous implementations:
- Per-word divergence with summation (one word diverging into a heap → the root cause of over-generic terms)
- Centroid voting (taking the mean → losing distributional information; every candidate near an over-generic term scores high)
- Mean collapse (a face must be preserved, not collapsed into a point)

The constraints above are consistent with the parameter-space voting semantics of the Hough transform: the detection target emerges from the joint pointing of many scattered points, not from single-point extrapolation or mean collapse (Hough, 1962).

#### Voting Formula

Each information word i votes independently on each eligible term t within the range gate:

$$\text{vote}_{i \to t} = w_i \cdot (\text{relW} + \text{domainW} + \lambda \cdot \cos_{47})$$

where:
- $w_i$ = the information word's own weight (reflecting its importance within the pool)
- $\text{relW}$ = NB300 semantic similarity (the 300-dimensional cosine between information word i and term t)
- $\text{domainW}$ = the domain-match bonus (the reward when the term's axis matches the domain signal)
- $\cos_{47}$ = the 47D localization signal (added to the vote value when P1_NODE9_LOC_VOTE is on, with weight LOC_VOTE_W = 0.3)
- $\lambda$ = the localization-into-vote switch (default on; judged positive and promoted by a 200-case A/B on 2026-07-03)

Accumulation yields the total vote of each eligible term:

$$\text{totalVote}(t) = \sum_{i} \text{vote}_{i \to t}$$

$$\text{voterCount}(t) = \#\{i : \text{vote}_{i \to t} > 0\}$$

The 47D range-gate threshold `VOTE_COS_FLOOR = 0.15` comes from the six-degree-path stopping condition in the algorithm design document, "association too small (< 0.15) → automatic stop"; it shares the same value as the stopping gate of the path-decay family and is not arbitrarily chosen.

#### Three-Channel Unified Accumulator

All voting channels converge into a single accumulator `_voteAcc`; Hough is the only word-emitting path:

1. **Hough channel** (primary): M*N independent votes of M information words x N eligibles
2. **ConceptNet confirmation channel**: bounded many-to-one confirmation votes, `CN_VOTE_WEIGHT(0.5) * min(1, reacherCount / CN_FULL_REACH(3))`
3. **bridge_to confirmation channel**: bounded confirmation from AT's static exact mapping, `BRIDGE_WEIGHT(0.6) * min(1, reacherCount / BRIDGE_FULL_REACH(2))`

The CN and bridge channels are both "bonus confirmations," not independent word emitters — their votes merge into the Hough accumulator to participate in unified ranking, and they do not independently produce direction words.

IDW (Inverse Distance Weighting, Shepard 1968) decay participates in the vote computation as a distance-modulation factor, ensuring that the voting weight of distant candidates naturally decreases.

#### Final Direction-Word Score

```
score = totalVote * max(axisDecay, houghDecayFloor) * resonanceWeight
```

where `axisDecay` is the decay coefficient of the axis to which the term belongs (from node3's `exp(-rank * beta)`), and `resonanceWeight` is the mechanism-resonance discount (targets receiving votes from only a single channel are discounted).

### 5.2.3 Core Code

The complete Hough many-to-one voting implementation resides in the Node-9 direction-word selection module (the `selectDirectionWords` function). The following code shows the core voting loop:

```javascript
// Node-9 direction-word selection module — each information word votes independently on this eligible
for (const { iw, a47t: iw47t, iwVec, norm47: iwNorm47, iwWeight, iwNbVec } of _iwPrecomputed) {
  // 47D range gate: does this information word point to this eligible (localization only, no scoring)
  let cos47;
  let dot = 0;
  for (const k of AXES_47_KEYS) dot += (iw47t[k] || 0) * (a47t[k] || 0);
  cos47 = dot / (iwNorm47 * a47Norm);
  if (cos47 < VOTE_COS_FLOOR) continue;  // failed the range gate: no vote

  // NB300 scoring: semantic relatedness between this information word and this eligible
  let relW = CONVERT_NB_NULL_W;  // OOV neutral vote 0.3
  if (iwNbVec && eligNbVec) {
    let dot = 0;
    for (let j = 0; j < 300; j++) dot += iwNbVec[j] * eligNbVec[j];
    relW = Math.max(0.01, dot * _vecW);
  }

  // Vote = information-word weight * (semantic relatedness + domain match + localization signal)
  const vote = iwWeight * (relW + _domainW + (_P9_LOC_VOTE ? LOC_VOTE_W * cos47 : 0));
  _entryTotalVote += vote;
  _entryVoterCount++;
}
```

The loop above computes the 47D range gate and NB300 semantic relatedness for each eligible term in turn, finally accumulating into the total vote count.

### 5.2.4 Pyramid Output

The final output of direction words adopts a three-tier pyramid structure (from design document No. 71, "Stereoscopic Algorithm Design," Section 3.2 Phase 5). This structure corresponds to the system's established overall criterion for divergence quality — output should combine the novelty of remote association with a traceable basis of relatedness. This criterion is consistent with Mednick's (1962) theory of creative association: creative output arises from the effective combination of remotely associated elements, not from groundless random jumps.

Table 5-5 shows the quantity caps, selection criteria, and design intents of the three pyramid tiers.

**Table 5-5: The Three-Tier Pyramid Structure of Direction Words**

| Tier | Count | Selection criterion | Design intent |
|------|------|---------|---------|
| apex | <=3 | Highest voterCount | The pool-wide consensus tier (the core product of many-to-one voting); the most accurately localized words |
| mid | <=8 | Ranked by score among non-apex | The main body of direction words |
| base | <=3 | Cross-primary-axis + hop>=2 | The remote-association tier — cross-domain six-degree-path words |

---

## 5.3 The Red-Line Filtering System (Node-10)

Node-10 (`refineDirectionWords` + `isRedlineWord`, located in the BLQ module) is the last filtering stage at P1's output end, responsible for quality re-ranking and red-line hard exclusion before direction words are delivered to the main AI.

### 5.3.1 The Four Output Red Lines

The `isRedlineWord` function implements hard exclusion through four groups of regular expressions. Table 5-6 shows the category, regex seed examples, and academic basis of the four red lines.

**Table 5-6: The Four Output Red Lines of Node-10**

| Red line | Category | Regex seed examples | Academic basis |
|---------|------|------------|---------|
| R1 | Route words (route) | 建议 (suggest) / 应该 (should) / 方法 (method) / 步骤 (steps) / 策略 (strategy)... | The direction-route separation principle (a system design constraint, see Section 6.4) |
| R2 | Inducement words (induce) | 你需要 (you need to) / 你必须 (you must) / 快去 (go now) / 赶紧 (hurry)... | Preventing P1 from overstepping to command the user |
| R3 | Subjective proxy statements (subjective) | 你很 (you are very) / 你好 (you are so) / 你觉得 (you feel) / 感觉很 (it feels very)... | Forbidding expressing feelings on the user's behalf |
| R4 | Diagnostic words (diagnostic) | 症 (-osis/symptom) / 障碍 (disorder) / 综合征 (syndrome) / 确诊 (diagnosed)... | P1 gives direction, not diagnoses |

The red lines derive from the system's established four output prohibitions: no route words (concrete behavioral instructions or comforting scripts); no generic psychological-consolation content; no action commands to the user (of the kind "go travel / make a call / sleep early"); and, in the absence of context, no locking onto a single attribution — multi-disciplinary parallel presumption is used instead. This principle strictly confines P1's output to the functional boundary of "cognitive direction hints."

Words hit by a red line are excluded directly at the Pipeline-module stage and do not enter the final XML output.

### 5.3.2 Gaussian Gradual Decay

`refineDirectionWords` applies Gaussian gradual decay to direction words, replacing binary threshold filtering. The decay formula:

$$\text{decay}(d) = \max\left(\text{FLOOR},\; \exp\left(-\frac{(d - \text{PEAK})^2}{2 \cdot \text{SIGMA}^2}\right)\right)$$

where:
- $d$ = the NB300 cosine distance between the direction word and the input centroid (inputCentroid)
- PEAK = 0.45 (the optimal semantic distance — neither too near nor too far)
- SIGMA = 0.25 (the Gaussian width)
- FLOOR = 0.15 (the decay lower bound; no hard zeroing)

The design intent of Gaussian decay:
- **Words too near** ($d < \text{PEAK}$): too similar to the user's original text → they fall under the "null-value term" criterion (the main model can derive them on its own from reading the raw text, so the information increment is zero; see Section 6.4.2), and are decayed
- **Words too far** ($d > \text{PEAK}$): semantically too distant from the input → irrelevant noise, decayed
- **Words near the optimal distance** ($d \approx \text{PEAK}$): both related and novel → minimal decay, highest score

This is smoother than a traditional binary hard threshold (e.g., deleting outright at cos > 0.7) — the same word does not flip between retention and deletion over a tiny difference between 0.69 and 0.71.

Final direction-word score:

```
finalScore = node9Score * min(factors) * gaussDecay
```

### 5.3.3 Cliff Detection

To handle natural gaps that may appear in the direction-word score distribution, node10 implements a cliff-detection mechanism:

```
If preceding word's score > following word's score * N10_CLIFF_RATIO(3)
  → truncate the output here (retaining at least N10_CLIFF_MIN = 5 words)
```

Cliff detection allows the output to contain fewer than the standard 15 direction words — when the score distribution shows a clear gap, the system prefers outputting fewer words to padding the count. This corresponds to the system's established design principle of "precision over quantity," whose capacity orientation is consistent with Cowan's (2001) working-memory-capacity research (4 +/- 1 core information items as the optimal capacity).

### 5.3.4 The Complete Output Pipeline

Node-10's complete processing pipeline is as follows:

```
node9 direction words top20
  → refineDirectionWords (Gaussian decay + BLQ re-ranking + cliff detection)
  → isRedlineWord (hard exclusion by 4 regexes)
  → final p1_act XML top15
```

The four steps execute in sequence: re-rank first, then hard-exclude, finally producing the XML output capped at 15 direction words.

---

## 5.4 Tokenization and Preprocessing (Node-1)

Node-1 (the Node-1 tokenization module, 466 lines) is the entry point of the P1 pipeline, undertaking the function of "the first segment of the three-segment mechanism = contraction": contracting the user's natural-language input into an informative word set.

### 5.4.1 The jieba + BCC Dual Engine

The tokenization engine uses jieba-wasm (the WebAssembly build of Jieba tokenization) as the primary engine, with greedy matching over the BCC (BLCU Corpus Center, the modern-Chinese corpus of Beijing Language and Culture University) frequency table as the fallback. The following code shows the invocation order of the two engines:

```javascript
// Node-1 tokenization module — tokenization function
function _tokenizeOrdered(text) {
  if (_jiebaCut) return _jiebaCut(text, true);  // jieba primary engine
  // fallback: BCC frequency-table greedy maximum matching
  // ...for each contiguous run of Chinese characters, take the longest match with BCC freq>0 among len=MAX_GRAM(4)..2
}
```

The BCC greedy fallback path is taken only when jieba is missing. A design constraint (established 2026-05-29) requires the tokenization layer to cover both Chinese and English: English words are exempt from the Chinese BCC high-frequency filter and go through an independent English stop-word list (sources: the P1 resource library's pattern (CLiPS, BSD) stop words + opinion-lexicon-EN).

Incident record of 2026-07-20: when jieba-wasm was missing, the system once silently degraded to BCC greedy matching, producing cross-word-boundary fragmented tokens such as "我觉 / 我一 / 了兴" (fragments straddling word boundaries), affecting node2 (fragmented words have no SWOW cues) and node0 anchor quality.

After the fix, this was changed to an explicit warning (console.warn), with no more silent degradation.

### 5.4.2 Three-Tier Noise Exclusion

The noise-exclusion mechanism was established on 2026-05-29 as a "soft-degradation" scheme: no binary deletion, but tiered down-weighting, ultimately forming a three-tier noise-exclusion mechanism. Table 5-7 shows the BCC frequency thresholds, handling, and example words of the three tiers.

**Table 5-7: The Three-Tier Noise-Exclusion Mechanism**

| Tier | BCC frequency threshold | Handling | Examples |
|------|-------------|---------|------|
| **Hard drop** | > 3,000,000 | Does not enter the word pool | 的, 了, 是 (function words: "of," perfective particle, "is") |
| **Demote** | > 500,000 and <= 3,000,000 | Enters the pool with low weight 0.1 | 知道 (know), 感觉 (feel) |
| **Keep** | <= 500,000 | Enters the pool at full weight 1.0 | 失眠 (insomnia), 焦虑 (anxiety) |

Hard drop is additionally guarded by part-of-speech (POS) dual-signature verification: a word is hard-dropped only when both the HanLP POS dictionary and the jieba POS dictionary tag it as a function word (d/c/f/m/q/r/p/u/e/y/o/w/s/l) — preferring over-retention to mistaken deletion.

The design criterion for noise exclusion is: the filtering target is confined to uninformative high-frequency common words, not content words with diagnostic value — noise exclusion is informativeness filtering, not a one-size-fits-all frequency cut.

The THUOCL professional-domain prefix arbitration of 2026-06-13 is an elegant boundary-case treatment: words such as "前端 (front-end) / 后端 (back-end) / 终端 (terminal)" are dual-tagged as locative words (f) by HanLP and jieba from the general-language perspective, yet are core terms in an IT context.

The solution is to consult the THUOCL professional-domain dictionary — if a 2-3-character word is the prefix of >= 3 longer terms within some professional domain (e.g., "前端" (front-end) is the prefix of 30 IT words such as "前端开发 (front-end development) / 前端工程师 (front-end engineer) / 前端框架 (front-end framework)..."), it is judged a domain term rather than a function word and is allowed through.

Measured results validated the scheme's effectiveness: positive cases 前端 (front-end) IT:30 / 后端 (back-end) IT:3 / 终端 (terminal) IT:5 were all rescued; among negative cases, all 27 function words had < 3 in any single professional domain — zero false kills.

### 5.4.3 Degree-Adverb Binding

Degree adverbs and negation words are not excluded as noise; instead, they are extracted as an `intensifiers` signal for downstream consumption. The degree-adverb lexicon is defined as follows:

```javascript
// Node-1 tokenization module — degree-adverb lexicon
export const DEGREE_WORDS = new Set([
  "死了", "太", "好", "很", "非常", "超", "特别", "真", "实在", "真的",
  "简直", "完全", "彻底", "这么", "那么",
  "so", "really", "extremely", "absolutely", "totally", "completely",
]);
```

Source of the lexicon above: the existing AMPLIFIERS lexicon of the connective-classification module (not AI-generated).

Negation words are loaded from `polarity_lexicon.json#negation_zh + negation_en` (migrated in S7-1 on 2026-07-22, expanded from 11 hard-coded words to 40), sharing the same source as the polarity-detection module.

Intensifier binding rule: search only forward for the nearest information word as the modification target (design constraint: degree adverbs are handled as prepositive modifiers of information words, established 2026-05-29). For example, in "太害怕" ("too scared"), "太" ("too") binds to "害怕" ("scared"), outputting `{word:"太", target:"害怕", type:"degree"}`.

### 5.4.4 Output Interface

Node-1 ultimately exposes the following standardized interface to downstream nodes:

```javascript
{
  words: string[],           // the deduplicated information word set
  wordWeights: {word: float},// per-word weight (keep=1.0, demote=0.1)
  demoted: string[],         // the list of demoted words
  intensifiers: [{word, target, type}], // degree/negation signals
  text: string,              // the raw input text
}
```

This interface is the sole contract boundary between Node-1 and subsequent nodes; downstream modules consume only these five fields.

---

## 5.5 The Axis System

**Architectural positioning (stated before the subsections)**: the axis system is not a table-lookup scoring step within the pipeline but P1's core network structure — the 6 primary axes undertake coarse localization, the 47 sub-axes undertake directional refinement (characterizing the semantic rate of change along each fine-grained direction within the coarse localization), and these connect further to 8+ external resource libraries (AT/TI/SWOW/NB300/Domain/cogmech/the bridge library, etc.), forming a **multi-layer interconnected structure**: word activation propagates through the levels and aggregates additively (high volume, many points). The 12-stage pipeline of Chapter 3 is merely one traversal order of this structure, not the system itself.

In design semantics, each axis's localization output for each word is **multiple information points** (information + information range), not a single score: each axis internally contains multiple discipline-based dimensions of judgment, overlaid with dedicated judgments for particular entries or content, so the overall structure is "6+n" rather than 6 scalars. This "axis as subspace" design is structurally consistent with Gardenfors's (2000) conceptual spaces theory, in which a domain is composed of multiple integrable dimensions.

### 5.5.1 Definition of the Six Primary Axes

P1's six primary axes were finalized on 2026-05-11 as fixed disciplinary dimensions:

```javascript
// Axis system module — 6-axis definition
// Linqing: "linguistics, sociology, informatics, psychology, logic, cognitive science"
const AXES = ["psychology", "informatics", "sociology", "logic", "linguistics", "cognitive"];
```

The core constraint of this definition is: the primary axes must be fixed disciplinary dimensions (psychology / informatics / sociology / logic / linguistics, etc.), not data-driven statistical clustering axes.

Evolution history: 4 primary axes → QKV moved out of the axis layer and replaced by "informatics" (design document No. 34, 2026-05-11) → 5 fixed disciplinary axes → 6 fixed (adding cognitive, session13). The early emergent axes (dynamically detected adaptive axes) were rejected in favor of fixed disciplinary axes.

The design intent of multi-information-point localization can be illustrated by a hand-annotated example: for the input "你为什么这么笨" (lit. "why are you so stupid"), each axis produces multiple information points — informatics: negation / negative side / error / disappointment; logic: error / long-standing problem / dejection; psychology: negative / disappointment / expectations unmet. Each axis yields a set of information annotations, not a single vague property.

**The design layer versus the implementation layer of the scoring mechanism**: by design, 8 classification resources produce **multiple independent information points** per word x per axis — cogmech's dimension details, Domain's domain membership, BCC's three-domain distribution, VAD's triple, etc., are each an independent "information + information range" (the `dimDetail` field in the code contract preserves this 8-source detail); the error occurs downstream — the current implementation **additively folds these information points into one scalar score per axis** before feeding faceByAxis ranking, constituting information loss at the axis layer (rooted in the same deviation annotated in Chapters 3 and 4; pending a framework-level fix). Table 5-8 shows the entry counts, coverage, and primary contributing axes of these 8 resources (the resource inventory itself is factual and unaffected by the deviation above).

**Table 5-8: The 8 Classification Resources for 6-Axis Scoring**

| Source | Entries | Coverage | Primary contributing axes |
|------|--------|---------|-----------|
| cogmech_gemini.json | 9,134 words | Cognitive-mechanism annotation (emotion/object/process, etc.) | psychology, cognitive |
| DomainWordsDict | 561,000 words, 69 domains | All-domain classification (computing/social science/literature, etc.) | All axes |
| THUOCL | 11 domains | Curated domain words (IT/medicine/law/finance, etc.) | informatics, sociology |
| activation_terms | ~4,500 terms | Known P1 terms | All axes |
| BCC three-domain distribution | 434,000 words | News/literature/dialogue three-domain ratios | informatics, linguistics, psychology |
| NRC-VAD v2 | 54,801 words | valence/arousal/dominance | psychology (auxiliary) |
| concreteness | 87,942 words | Concreteness | informatics, cognitive |
| NB300 fallback | 285,000 words | Anchor cosine when the first 7 sources are all empty | All axes |

### 5.5.2 The 47 Sub-Axes (Actually 59 Dimensions)

The 47 sub-axes form the fine-grained coordinate space of P1's output end. "47" is a historical name; there are actually 59 dimension keys:

$$\text{47 base} + \text{12 cross-disciplinary} = 59 \text{ dimensions}$$

- **47 base dimensions**: 9 psy + 10 info + 7 soc + 7 logic + 10 lang + 4 mode
- **12 cross-disciplinary dimensions**: 6 sem (semantic) + 6 sm (sensorimotor)

Sub-axis naming examples per disciplinary group:

```
psychology  → psy_therapy, psy_analysis, psy_cbt, psy_dbt, psy_common,
              psy_emotion, psy_interpersonal, psy_physiology, psy_psychoanalysis
informatics → info_prog, info_frontend, info_backend, info_data, info_bug,
              info_multiplatform, info_tools, info_common, info_algo, info_learning
sociology   → soc_work, soc_interpersonal, soc_roles, soc_qa, soc_casual,
              soc_discussion, soc_norms
logic       → logic_behavioral, logic_linguistic, logic_design, logic_exploration,
              logic_decision, logic_debug, logic_causal
linguistics → lang_literary, lang_jp_ln, lang_cn_ln, lang_us_novel, lang_character,
              lang_3elements, lang_anime, lang_plot, lang_roles, lang_analysis
mode        → mode_chat, mode_airp, mode_code, mode_work
```

The system established three delimitations of the relation between the 6 axes and the 47 axes: the two have different functions and do not form a superior-subordinate or same-kind relation; the 6 axes determine divergence points (input-side disciplinary localization), while the 47 axes give coarse localization on the output side and expand output on that basis; the 47 axes participate in computation as activated subsets, not with all dimensions simultaneously in effect.

The design basis of the 47 axes has two layers. The theoretical layer cites the conceptual spaces theory of Gardenfors (2000), *Conceptual Spaces* — a concept is a convex region in a high-dimensional space. The structural layer's positioning is: after the 6 primary axes give a word's coarse localization, the 47 sub-axes characterize the **semantic rate of change along each fine-grained direction** within that localization, undertaking directional refinement and driving subsequent directed divergence and "expanded output." It is a directional operation, not a static coordinate table.

Node-4 (the Node-4 sub-axis localization module) is responsible for 47-axis coordinate hits; after the C2 rewrite of 2026-06-13, it changed from "accumulative scoring" to a "coordinate hit set" — the final design ruling established the division of responsibility "the 47 axes only localize and do not score; scoring belongs to NB300 + BLQ" (note: "no scoring" constrains participation in quality ranking; it does not license degrading localization into counting).

**Deviation between the current implementation and the design**: the current code is `witnesses[subAxis].add(hit word)`, with activated[subAxis] = |witnesses[subAxis]| — reducing the localization of "characterizing the semantic rate of change along fine-grained directions" to a count of "number of hit words = activation strength"; the "expanded output" function cited above does not exist in the hit-count model. This is a dimensionality-reduced execution of the design (rate-of-change localization → hit set, an information loss) and is an item pending refactoring.

### 5.5.3 The Axis-Decay Formula

Axis decay controls the influence weight of different axes. The formula comes from the framework design constraint "with a primary direction axis + axis decay": the primary direction axis has the largest weight, distant axes have decreasing weight but are not deleted, and the decay shape is exp(-rank*beta):

$$\text{axisDecay}[\text{axis}] = \begin{cases} e^{-\text{rank} \times \beta} & \text{if relevance} > 0 \\ 0 & \text{otherwise} \end{cases}$$

where:
- rank = the axis's position when sorted in descending order of relevance (face contribution Sigma v); 0 = the primary direction axis
- beta = the decay rate (AXIS_DECAY_BETA = 0.5, to be settled by experiment)

The formula is implemented in code as follows:

```javascript
// Node-3 six-axis face module — axis-decay computation
axisDecay[axis] = axisRelevance[axis] > 0
  ? +Math.exp(-rank * AXIS_DECAY_BETA).toFixed(4)
  : 0;
```

Table 5-9 shows the actual decay coefficients for each axis rank at beta = 0.5.

**Table 5-9: Actual Effect of Axis-Decay Coefficients (beta = 0.5)**

| Axis rank | Decay coefficient | Meaning |
|---------------|---------|------|
| 0 (primary axis) | 1.0000 | Fully retained |
| 1 (secondary axis) | 0.6065 | ~61% retained |
| 2 (distant axis) | 0.3679 | ~37% retained |
| 3 | 0.2231 | ~22% retained |
| 4 | 0.1353 | ~14% retained |
| 5 | 0.0821 | ~8% retained |

Key design constraint: distant axes decay but are **not deleted** (decay > 0, never zero). This corresponds to the system's established "soft isolation" principle (hard rule #48) — no hard zeroing; weak signals are preserved.

### 5.5.4 AXIS_CUTOFF Soft Stop

The divergence-threshold constraint established in the framework route is: an axis whose relevance is below 40% does not participate in divergence. This constraint is implemented as the AXIS_CUTOFF mechanism:

```javascript
// Node-3 six-axis face module
const AXIS_CUTOFF = Number(process.env.P1_AXIS_CUTOFF ?? 0.40);
// Relevance = this axis's Sigma v / the primary axis's Sigma v; axes < CUTOFF do not diverge (no anchor-word injection),
// but existing face words are not deleted (soft stop, not hard deletion)
```

AXIS_CUTOFF = 0.40 is an algorithmic constant given by the design (not a magic number self-selected at the implementation layer). Axes below this threshold do not participate in axisDiverge anchor injection, but their existing face words are retained — a "soft stop" rather than a "hard deletion."

### 5.5.5 The Coordinate-Hit Algorithm

Node-4 probes divergent words' hits on the 47 sub-axis coordinates via 4 paths. Table 5-10 shows the data sources and hit methods of these 4 paths.

**Table 5-10: The 4 Paths of 47-Sub-Axis Coordinate Hits**

| Path | Data source | Hit method |
|------|--------|---------|
| path1 | AT axes_47 + atDimToSubAxis | A divergent word matches an AT term name → hits the axes_47 coordinates |
| path2 | cogmech dimDetail + CN daily | dimDetail dimensions → sub-axes; CN daily words → soc_casual |
| path3 | DomainWordsDict / THUOCL | Domain-file index → sub-axes (coarse mapping) |
| path4 | BCC three-domain distribution | A share >= 0.45 counts as a hit (news→info, lit→lang, dialogue→psy+soc) |

After the C2 rewrite of 2026-06-13, all paths were changed to hit probes (`_hit`), no longer accumulating val*weight scores. The `atDimToSubAxis` function (the axis system module) implements the mapping from AT dim names to 47-sub-axis names through switch+regex full-prefix coverage, covering 540 AT dims.

The key-name split BUG (root-fixed 2026-06-03): theoretical keys on the producer side (such as `cog_general`, `lang_narrative`) did not match the FIELD keys on the consumer side (`psy_*`, `info_*`, etc., the 59 keys), causing silent loss.

The fix was to complete the mapping via the `_N4_THEORY_TO_FIELD` full mapping table (43 keys), folding all theoretical keys by disciplinary semantics into the nearest FIELD key; residual loss after completion = 0.

---

## Chapter Summary

BLQ scoring and the output system constitute the complete convergence path of the P1 pipeline from the "information word pool" to the "final direction-word output." Its design core can be summarized at four levels:

1. **Tokenization preprocessing** (Node-1): jieba + BCC dual-engine tokenization, three-tier noise exclusion, degree-adverb binding — providing a clean input word set for the rest of the pipeline.

2. **The axis system** (Node-3/4): the conceptual space formed by 6 primary axes x 47(59) sub-axes, determining the coordinate positions of information words in the multi-disciplinary space through 8-resource scoring + 4-path hit probing. The axis decay `exp(-rank*beta)` guarantees primary-axis dominance while distant axes never reach zero.

3. **Many-to-one voting** (Node-9): the Hough-Transform-inspired M*N independent voting mechanism, three channels (Hough + CN + bridge) ranked through a unified accumulator, with three-tier pyramid output.

4. **Quality filtering** (Node-8/10): BLQ additive CombSUM ranking (6 bonus dimensions + 4 suppression dimensions), Gaussian gradual decay, cliff detection, and hard exclusion by 4 output red lines — ensuring that the final output is both high-quality and within bounds.

The restructuring from multiplicative to additive is a representative design decision: it transforms "multi-dimensional assessment" from AND logic (every dimension must be good) into additive fusion with OR logic (being good on most dimensions suffices to qualify), matching the natural pattern of multi-factor holistic judgment in human cognition and aligning with the mature practice of CombSUM multi-source fusion in information retrieval.
