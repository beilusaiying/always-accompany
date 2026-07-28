# Chapter 4 Core Algorithms: Recall and Divergence

> Chapter overview: Section 4.1 develops the four recall-side paths (multi-route pool construction, contextual anchor recall, data-layer recall, and IDF/IPW weighting) and how they aggregate candidate vocabulary into a single pool; Section 4.2 develops the complete divergence-side chain from SWOW association, six-axis localization, and 47-sub-axis coordinates to spatial voting and the five paths of second-stage divergence; Section 4.3 explains how the system continuously self-updates through a three-layer mechanism of real-time statistics, P9 calibration, and hot reloading. Every sub-algorithm is accompanied by its academic basis, mathematical formulas, core code, design decisions, and observed effects; this is the central chapter for understanding the algorithmic core of P1.

The core task of the P1 pipeline is to take a single natural-language user input and, through the complete chain of "contraction - localization - divergence - voting - word selection," produce a **layered set of direction words**: a core layer of 4-5 high-quality direction words (corresponding to the Cowan 4±1 working-memory capacity argument; the implemented values are v5.K top6 and the pyramid apex layer), plus a marginal layer of at most 15 words (p1_act top15, corresponding to the marginal-layer design principle of "tolerating low-value candidates and trading a low threshold for wide semantic coverage"), used to guide the response direction of the downstream large language model. Direction words are not restricted to single disciplinary terms — per the design definition of the function of Contraction-2 (extracting word properties and converting them into technical terms, work citations, or fragment words), direction words fall into three categories: **technical terms** (the primary output for chat/work/ide modes), **work/scene citations** (the primary output for airp mode, e.g., "provide some analogous scenes from novels"), and **fragment words**.

Following the pipeline execution order, this chapter fully develops every algorithmic subsystem on the recall side (Stage 1) and the divergence side (Stages 2-7): giving the academic basis, mathematical formulas, core code, design decisions, and observed effects.

---

## 4.1 Recall Algorithms

Recall is the first step of the P1 pipeline. The functional definition established by the system design is: P1's core function consists of two segments, "recall + divergence," with recall as the starting point of the entire pipeline; and the recall stage performs low-threshold, high-capacity broad-recall memory activation — preferring over-inclusion to omission, providing the downstream divergence with the widest possible anchor coverage, rather than the precision-oriented recall that the host system performs for injection purposes. This recall-oriented (rather than precision-oriented) retrieval objective forms a systematic contrast with the exact-matching paradigm of RAG (see Chapter 2, Section 2.2); from the perspective of fusion theory, low-threshold multi-route recall combined with downstream additive fusion is precisely the classic division of labor of CombSUM-family methods — "prefer abundant evidence over scarcity, and let the fusion layer discriminate quality" (Fox & Shaw, 1994).

The recall-side orchestrator `recallV2` (the Recall orchestration module) contains no algorithm itself; it merely chains five subsystems:

```
inputText → Node 1 (tokenization) → Node 2 (SWOW divergence + NB centroid) → multi-route pool (4-route merge)
         → Node 0 (contextual anchors) → Node 0-data (data-layer recall) → return recallResult
```

Each is developed in turn below.

---

### 4.1.1 Multi-Route Recall Pool Construction

#### Academic Basis

The core idea of the multi-route recall pool comes from **CombSUM fusion** in information retrieval (Fox & Shaw, 1994): results from multiple independent retrieval paths are merged by additive accumulation, rather than by multiplication or intersection. The fusion hard rule established by the system design for this is: multi-route results are aggregated into the same spatial pool via additive accumulation, and multiplicative fusion is forbidden — additivity preserves the independent contribution of each path (OR-gate semantics), whereas multiplication lets a zero score on any single path veto the whole (AND-gate semantics), contradicting the design goal of multi-source complementarity.

Each of the four paths has its own independent academic provenance:
- **Path 1 (name combinations)**: based on character alias expansion, belonging to the Entity Resolution paradigm.
- **Path 2 (SWOW)**: the Small World of Words human association network (De Deyne et al., 2019), detailed in Section 4.1.3.
- **Path 3 (NB300 nearest neighbors)**: ConceptNet Numberbatch multilingual word vectors (Speer et al., 2017), combined with Goldilocks remote-association theory (Mednick, 1962; Kenett et al., 2014).
- **Path 4 (mode resources)**: ConceptNet causal relations (Speer & Havasi, 2012), sensorimotor norms (Lynott et al., 2020), and the CFN Chinese semantic frame net (Liu & Li, 2016).

#### Formulas

**CombSUM merging**:

$$\text{strength}(w) = \sum_{r \in \text{routes}} s_r(w)$$

where $s_r(w)$ is the strength score of word $w$ on path $r$. The strength definitions per path are:

- Path 1 (names): $s_1(w) = 1.0$ (full weight upon a hit)
- Path 2 (swow): $s_2(w) = 1.0$ (divergeNode2 output registered directly)
- Path 3 (nb300): $s_3(w) = \cos(\mathbf{c}, \mathbf{v}_w) \cdot \text{ibFactor}(\cos)$
- Path 4 (modeRes): $s_4(w)$ depends on the specific sub-channel (CN by REL_WEIGHTS; SM/CFN are 1.0)

**Goldilocks ibFactor** (the nonlinear piecewise scaling of Path 3):

$$\text{ibFactor}(\cos) = \begin{cases} \text{cutoff} & \cos < 0.15 \\ 0.7 & 0.15 \leq \cos < 0.25 \quad \text{(too-near zone)} \\ 1.0 & 0.25 \leq \cos \leq 0.70 \quad \text{(optimal semantic distance band)} \\ 0.8 & 0.70 < \cos \leq 0.80 \quad \text{(too-far low segment)} \\ 0.5 & \cos > 0.80 \quad \text{(too-far high segment)} \end{cases}$$

Ranking key = $\cos \times \text{ibFactor}$, taking the top-K (default K=15).

The design principle followed by this piecewise function is: there exists an optimal intermediate band for the semantic distance between a candidate word and the input centroid — candidates that are too near are generic noise (any input drifts toward the centroid, so activation gain approaches zero), while candidates that are too far drift away from the semantic topic (rising noise proportion). This principle is consistent with the medium-association-distance-optimal hypothesis of remote association theory (Mednick, 1962) and with semantic-network creativity research (Kenett et al., 2014) — the "optimal semantic distance band" in the formula above is precisely the Goldilocks zone in that literature, and the inverted-U nonlinear relationship also has recent empirical support (Orwig, 2025).

**ConceptNet relation weights** (the CN sub-channel of Path 4). The table below lists each relation type and the basis for its weight, from highest to lowest:

| Relation type | Weight | Source |
|---------|------|------|
| Causes | 0.9 | Supplementary volume L756 dedicated experiment |
| MotivatedByGoal | 0.8 | Semantic-causality gradient |
| CapableOf | 0.7 | Semantic-causality gradient |
| UsedFor | 0.6 | Semantic-causality gradient |
| HasSubevent | 0.5 | Semantic-causality gradient |
| HasProperty | 0.5 | Algorithm pipeline L204 dedicated experiment |
| AtLocation | 0.4 | Semantic-causality gradient |
| HasA / PartOf | 0.3 | Semantic-causality gradient |
| RelatedTo | 0.1 | Supplementary volume L756 dedicated experiment |
| IsA | 0.05 | Auto-filtered (< 0.1 threshold) |
| Synonym | 0.05 | Auto-filtered |
| Antonym | 0.01 | run23 measured hard evidence (-55%) |

**MODE_ACTIVE binary switch matrix** (mode-activation control of Path 4):

The design principle followed by mode differentiation is mechanism-level switching rather than weight-level fine-tuning: different scenario modes activate different combinations of mechanisms, and any mechanism not activated is completely silent (zero contribution) rather than continuing to participate at a low weight. The engineering rationale for this principle is: a silent mechanism introduces no noise contribution to the fusion layer, and a binary switch matrix is enumerable, testable, and interpretable — superior to hard-to-audit continuous weight tuning. This is an engineering principle established within this system.

The system contract accepts five scenario modes (chat / code / ide / work / airp, consistent with the recallV2 contract in Chapter 3, Section 3.3.2), among which ide is a first-class mode whose scoring criteria were defined personally by the designer. The `MODE_ACTIVE` constant is defined with four keys; the table below lists its on/off state for the six recall routes:

| Mode | names | swow | nb300 | cn | sm | cfn |
|------|-------|------|-------|-----|-----|-----|
| chat | on | on | on | off | on | on |
| code | on | on | on | on | off | off |
| work | on | on | on | on | off | on |
| airp | on | on | on | off | off | on |

**The relation between ide and code** (per current code facts): ide is not listed as a separate key in `MODE_ACTIVE`. The vocabulary-loading layer folds ide into code (`mode === "ide" ? "code"`, i.e., ide and code share the same set of AT/TI vocabulary files); the CN branch of Path 4 also lists ide alongside code/work as activated modes. However, the default fallback at the `MODE_ACTIVE` lookup site is chat (`MODE_ACTIVE[mode] || MODE_ACTIVE.chat`), which is inconsistent with the "ide→code" folding direction of the vocabulary layer — the two folding sites should be unified so that ide is treated as code; this is an identified item pending unification.

#### Core Code

`buildRecallPool` (the Pool construction module):

```javascript
export function buildRecallPool(ctx) {
  const routes = [routeNames(ctx), routeSwow(ctx), routeNb300(ctx), routeModeRes(ctx)];
  const poolMap = new Map();
  for (const r of routes) {
    for (const c of r.words) {
      const e = poolMap.get(c.word);
      if (e) { e.sources.push(c.source); e.strength += c.strength; } // CombSUM additive accumulation
      else poolMap.set(c.word, { word: c.word, sources: [c.source], strength: c.strength });
    }
  }
  // Cross-route resonance tally: V1 "how many independent routes recalled this word"
  const RES_W = +(process.env.P1_POOL_RESONANCE_W || 0);
  if (RES_W > 0) {
    for (const e of poolMap.values()) {
      const srcKinds = new Set(e.sources).size;
      if (srcKinds > 1) { e.strength += RES_W * (srcKinds - 1); }
    }
  }
  // Merge non-swow new words into swowPool
  if (ctx.swowPool && typeof ctx.swowPool.add === "function") {
    for (const e of poolMap.values()) {
      if (!e.sources.includes("swow") && !ctx.swowPool.has(e.word)) {
        ctx.swowPool.add(e.word);
      }
    }
  }
  return { swowPool: ctx.swowPool, poolMap, trace: { ... } };
}
```

Goldilocks ibFactor core (`routeNb300`, the Pool construction module):

```javascript
function routeNb300(ctx) {
  const centroid = ctx.inputCentroid;
  const pool = ctx.nbPool;
  // ...
  for (const [w, vec] of pool) {
    if (own.has(w) || (swow && swow.has(w))) continue;
    let dot = 0, norm2 = 0;
    for (let i = 0; i < vec.length; i++) { dot += centroid[i] * vec[i]; norm2 += vec[i] * vec[i]; }
    const cos = dot / Math.sqrt(norm2);
    if (cos < _NB_FLOOR) continue;           // cutoff in the extreme-low zone
    let ib = 1.0;
    if (cos < _NB_NEAR) ib = _NB_IB_NEAR;           // too near → 0.7
    else if (cos > _NB_FAR_HI) ib = _NB_IB_FARHI;   // too-far high segment → 0.5
    else if (cos > _NB_FAR_LO) ib = _NB_IB_FARLO;   // too-far low segment → 0.8
    cands.push({ word: w, cos, ib });
  }
  cands.sort((a, b) => (b.cos * b.ib) - (a.cos * a.ib));
  return { words: cands.slice(0, K).map(c => ({ word: c.word, source: "nb300",
           strength: +(c.cos * c.ib).toFixed(4) })), ... };
}
```

#### Design Decisions

1. **Why four routes rather than one?** Review No. 002 rejected the initial SWOW-only single-route design (insufficient candidate-pool coverage). The original design was always multi-route divergence merged into one pool for unified scoring; SWOW alone is seriously insufficient (low association coverage in modes other than chat).
2. **Why CombSUM rather than multiplication?** The system's additive-fusion hard rule (see above) — in a multiplicative chain, a single zero factor collapses the whole chain (premature misdiagnosis / over-generic terms), whereas additivity preserves the independent contribution of each route.
3. **Why does Goldilocks use soft down-weighting rather than hard truncation?** Hard rule #48: "soft down-weighting, not hard filtering" — words with extremely low cos may still enter the pool with a small contribution (ibFactor = 0.7), so marginally valuable words are not lost to a fixed threshold.
4. **Sensorimotor and CFN in parallel rather than mutually exclusive**: per the mechanism-combination differentiation principle (what gets activated is a combination of mechanisms, not a single mechanism), SM and CFN may be activated in parallel. SM coverage is only 10% (the 664-word set is dominated by embodied nouns), while CFN covers 62,280 words across 757 frames; the two are complementary.

#### Observed Effects

Taking the chat-mode input "我最近压力好大" (lit. "I've been under a lot of pressure lately") as an example:

| Route | Sample output | Word count |
|------|---------|------|
| route1 names | (no hit; the input contains no character names) | 0 |
| route2 swow | 焦虑 (anxiety), 紧张 (tension), 工作 (work), 疲惫 (exhaustion), 休息 (rest), 放松 (relaxation), 心理 (psychology), 睡眠 (sleep) | ~15 |
| route3 nb300 | 倦怠 (burnout), 负担 (burden), 承受 (bearing), 困扰 (distress), 烦恼 (worry) | ~10 |
| route4 sm | 胸闷 (chest tightness), 头痛 (headache), 肩膀 (shoulders) (divergence within the same sensory channel) | ~5 |
| route4 cfn | 应对 (coping), 调节 (regulation), 情绪管理 (emotion management) (same-frame words) | ~6 |
| **Merged pool** | **~30-40 words** | |

---

### 4.1.2 Node-0 Contextual Anchor Recall

#### Academic Basis

Node-0's contextual recall adopts **dual-signal fusion** — a linear combination of lexical intersection (Set Intersection) and semantic vector similarity (Cosine Similarity in NB300 space).

This design combines exact matching at the lexical level with soft matching at the semantic level, corresponding to the hybrid-retrieval paradigm in information retrieval that runs BM25 and vector retrieval together: an exact signal and a semantic signal fused linearly.

Inverse Propensity Weighting (IPW) is used for word-level ranking; its source is the propensity-score-correction literature in recommender systems (Schnabel et al., 2016). P1 adapts it as: high-frequency words (high BCC frequency = high "propensity" in the corpus) are down-weighted, and low-frequency words (high specificity) are up-weighted.

#### Formulas

**Sentence-level scoring**:

$$\text{combined}_s = \text{swowScore}_s + \begin{cases} \text{nbScore}_s \times 10 & \text{if } \text{nbScore}_s > 0.15 \\ 0 & \text{otherwise} \end{cases}$$

where:
- $\text{swowScore}_s = \sum_{w \in \text{inputSwow} \cap \text{ctxSwow}_s} \text{poolMap.strength}(w)$, i.e., the weighted intersection between the input divergent word pool and the divergent word pool of the context sentence.
- $\text{nbScore}_s = \cos(\mathbf{c}_{\text{input}}, \mathbf{c}_{\text{ctx},s})$, i.e., the 300-dimensional cosine similarity between the input centroid and the context-sentence centroid.
- Amplification gate 0.15 + amplification factor 10: when the semantic similarity exceeds the threshold, its contribution is amplified 10-fold into combined, so that the semantic signal produces significant discrimination on top of the lexical-intersection signal.

Filtering: only $\text{combined}_s \geq 3$ enters scoredCtx.

**Word-level ranking** (additive formula):

$$\text{rank}(w) = \text{combined}_{s(w)} + \text{infoW}(w) + \text{concBonus}(w)$$

where:
- $\text{infoW}(w) = \frac{1}{\sqrt{\text{bccFreq}(w) + 1}}$ (IPW, inverse propensity weighting)
  - High-frequency word 549541 → 0.001; mid-frequency word 1604 → 0.025; low-frequency word 10 → 0.30; zero frequency → 0
- $\text{concBonus}(w)$ (concreteness bonus, default off) = $\frac{5 - \text{concreteness}(w)}{4} \times \text{weight}$

**Anchor strength**:

$$\text{strength}(w) = \left(0.3 + 0.05 \times \min(\text{combined}_{s(w)}, 8)\right) \times \text{bccPenalty}(w)$$

$$\text{bccPenalty}(w) = \begin{cases} 0.05 & \text{bccFreq}(w) > 300000 \\ 1.0 & \text{otherwise} \end{cases}$$

#### Core Code

`recallNode0` (the Node-0 contextual recall module), key passages:

```javascript
// Step 5: score each sentence
for (const sent of ctxSentences) {
  const ctxWords = runStep1Extract(sent).words.filter(w => w.length >= 2 && !_noise(w));
  const ctxSwow = new Set(ctxWords);
  for (const w of ctxWords.slice(0, CTX_SWOW_HEAD)) {
    for (const s of swowDiverge(w, CTX_SWOW_TOPK)) {
      if (s.word?.length >= 2 && !_noise(s.word)) ctxSwow.add(s.word);
    }
  }
  // Intersection scoring (poolMap-weighted)
  let swowScore = 0;
  for (const w of inputSwow) {
    if (ctxSwow.has(w)) {
      swowScore += (poolMap && poolMap.has(w)) ? poolMap.get(w).strength : 1;
    }
  }
  // NB300 centroid cosine
  let nbScore = 0;
  // ... (compute centroid and take the cosine dot product)
  const combined = swowScore + (nbScore > NB_AMP_THRESH ? nbScore * NB_AMP_FACTOR : 0);
  if (combined >= COMBINED_MIN) scoredCtx.push({ sent, ctxWords, swowScore, nbScore, combined });
}

// Step 6: word-level IPW ranking
for (const sc of scoredCtx.slice(0, TOP_CTX)) {
  for (const w of sc.ctxWords) {
    const bccF = _getBccFreq(w);
    let infoW = bccF > 0 ? 1 / Math.sqrt(bccF + 1) : 0; // IPW
    cand.push({ node: w, rank: sc.combined + infoW + concBonus });
  }
}
cand.sort((a, b) => b.rank - a.rank);
// Take the top ANCHOR_MAX=8 anchors
```

#### Design Decisions

1. **Why does recall "not dominate"?** The hard boundary set by the design is: recall results serve only as divergence anchors and do not dominate direction — anchor strength is capped at approximately 0.7, acting as a constraining aid for downstream divergence rather than as the primary source of direction.
2. **Why only 6 sentences?** The design boundary specifies that divergence consumes only the most recent 6 sentences of context and does not read the data layer — a short window prevents distant conversational noise from diluting the current semantics.
3. **IPW replacing a home-grown formula**: the initial version used the home-grown formula $1/(1 + \log_{10}(1 + f/1000))$, later replaced by the IPW $1/\sqrt{f+1}$ from the resource library — IPW penalizes high-frequency words more steeply (549541 → 0.001 vs. 0.27 in the old version), giving more precise influence as an additive term.
4. **Multiplication → addition**: the initial version used rank = combined * infoW (multiplicative); per the additive-fusion hard rule it was changed to the additive rank = combined + infoW, so that each dimension contributes independently, combined dominates, and infoW performs boundary fine-tuning.

#### Key Parameters

All parameters have been env-ized (A/B-testable via environment variables without code changes):

| Parameter | Default | Meaning |
|------|--------|------|
| P1_N0_CTX_SENT | 6 | Number of context sentences |
| P1_N0_SWOW_HEAD | 4 | Number of leading words per sentence to diverge |
| P1_N0_SWOW_TOPK | 4 | Number of SWOW associations |
| P1_N0_COMBINED_MIN | 3 | Valid-match threshold |
| P1_N0_AMP_THRESH | 0.15 | NB cosine amplification gate |
| P1_N0_AMP_FACTOR | 10 | NB cosine amplification factor |
| P1_N0_TOP_CTX | 4 | Number of top sentences from which to extract anchors |
| P1_N0_ANCHOR_MAX | 8 | Anchor cap |
| P1_N0_BCC_DEMOTE | 300000 | BCC soft down-weighting gate |

---

### 4.1.3 Node-0-data Data-Layer Recall

#### Academic Basis

Node-0-data is the concrete implementation of P1's memory-layer recall, adopting the multi-dimensional scoring framework of the **Generative Agents paradigm** (Park et al., 2023) — three independent dimensions, semantic (dSem), lexical informativeness (dLex), and importance (dImp), are normalized and summed with equal weights.

IDF is computed using the **sklearn convention**: $\text{idf}(w) = \log\frac{N+1}{\text{freq}(w)+1}$, where N = 379 million (the published total word-frequency statistic of BCC).

#### Formulas

**Three-dimensional scoring**:

$$\text{score}(e) = \hat{d}_{\text{Lex}}(e) + \hat{d}_{\text{Sem}}(e) + \hat{d}_{\text{Imp}}(e)$$

Raw values per dimension:
- $d_{\text{Lex}}(e) = \sum_{w \in \text{hits}(e)} \text{idf}(w) = \sum_{w \in \text{hits}(e)} \log\frac{3.79 \times 10^8 + 1}{\text{bccFreq}(w) + 1}$
- $d_{\text{Sem}}(e) = \cos(\mathbf{c}_{\text{input}}, \mathbf{c}_{\text{entry}})$ (entry-level NB300 centroid cosine)
- $d_{\text{Imp}}(e) = \text{LAYER\_W}[\text{layer}(e)]$, where hot=1.0, warm=0.85, cold=0.7

Normalization: each dimension is min-max normalized, then equal-weight CombSUM.

**Anchor strength** (with an upper bound):

$$\text{strength}(w) = \min(0.2 + 0.1 \times \text{vote}(w),\ 0.5)$$

The cap 0.5 < the contextual-anchor maximum 0.7 — **recall does not dominate**.

**BCC down-weighting**: $\text{bccFreq}(w) > 150000 \Rightarrow \text{vote}(w) \mathrel{*}= 0.05$

#### Core Code

`recallNode0Data` (the Node-0 data-layer recall module), key passages:

```javascript
// Entry splitting + tokenMatch exact matching
const subEntries = _splitEntries(ent.text);
for (const sub of subEntries) {
  const subTokens = new Set(runStep1Extract(sub.display).words.filter(sw => sw.length >= 2));
  const hits = qWords.filter(qw => subTokens.has(qw));
  if (hits.length === 0) continue;
  let dLex = 0;
  for (const h of hits) dLex += _idf(h);
  _scoredSubs.push({ subTokens, dLex, dSem: _entDSem, dImp: layerW, ent, hits });
}

// min-max normalization + equal-weight CombSUM + topK sub-entries
_norm("dLex"); _norm("dSem"); _norm("dImp");
for (const s of _scoredSubs) s.score = s.ndLex + s.ndSem + s.ndImp;
_scoredSubs.sort((a, b) => b.score - a.score);

// cos word-extraction voting
for (const s of _scoredSubs.slice(0, ENTRY_TOPK)) {
  const scoredW = [];
  for (const cw of s.subTokens) {
    const cwVec = opts.nbPool.get(cw);
    if (!cwVec) continue;
    scoredW.push([cw, _cosine(opts.inputCentroid, cwVec)]);
  }
  scoredW.sort((a, b) => b[1] - a[1]);
  for (const [fw] of scoredW.slice(0, VEC_TOPWORDS)) {
    // vote += s.score (additive accumulation of the sub-entry's three-dimensional score)
  }
}
```

#### Design Decisions

1. **tokenMatch replacing text.includes**: the design red line forbids brute-force substring/regex matching, requiring soft matching by vectors, word senses, and confidence instead. `text.includes("明白")` ("understand") would spuriously match "半透明白丝" ("semi-transparent white silk"), whereas `Set.has("明白")` would not. Diagnosis #80 confirmed that the root cause of the old brute-force matching was "frequency matching rather than association matching."
2. **Gate defaults to off**: per the design principle "unvalidated features must not be enabled by default" — `P1_DATA_RECALL` is off by default and is enabled manually after safety is confirmed.
3. **Strength cap 0.5**: lower than the contextual-anchor cap 0.7, ensuring that data-layer recall serves only as divergence seeds and does not dominate direction.

---

### 4.1.4 IDF / IPW Weighted Ranking

The P1 recall side uses two informativeness-weighting mechanisms in two independent nodes:

**1. IPW (Inverse Propensity Weighting)** — Node-0 word-level ranking

$$\text{infoW}(w) = \frac{1}{\sqrt{\text{bccFreq}(w) + 1}}$$

This is an adapted form of Inverse Propensity Weighting from recommender systems. In P1's additive ranking formula rank = combined + infoW, IPW acts as an additive term that imposes a continuous decay on high-frequency uninformative words (such as "明白" ("understand"), "接下来" ("next"), "觉得" ("feel")), rather than a binary blacklist.

The design follows hard rule #48, "continuous quantity, not a cliff" — no blacklist-based hard deletion; instead, every word receives a continuous informativeness score according to its BCC frequency. Its design semantics is localization rather than punishment: the goal of the weighting is not to suppress high-frequency words but to supply each word with an additional "informativeness-localization" dimension, so that discriminativeness participates in the additive ranking as an independent signal. This is in line with the information-theoretic interpretation of term specificity — discriminativeness is itself a measurable property of a word, not a penalty imposed on it (Sparck Jones, 1972).

**2. IDF (Inverse Document Frequency)** — Node-0-data entry-level ranking

$$\text{idf}(w) = \log\frac{N + 1}{\text{bccFreq}(w) + 1}, \quad N = 3.79 \times 10^8$$

The sklearn standard convention is adopted. "沙盘" ("sand tray") has a low BCC frequency → idf approximately 12 (a strong signal); "明白" ("understand") has a BCC frequency of 360 million → idf approximately 0.05 (contributing almost nothing). Informativeness determines rank, not frequency.

**The difference between the two**: IPW performs boundary fine-tuning within an additive formula (combined still dominates), while IDF makes the absolute contribution of the dLex dimension within the three-dimensional CombSUM.

---

## 4.2 Divergence Algorithms

Divergence is the core process of the P1 pipeline from Stage 2 to Stage 7. It takes the 30-40 divergent-word-pool entries produced by the recall stage and, through multiple processing layers — six-axis localization, 47-sub-axis coordinate hits, spatial voting, and second-stage divergence — ultimately produces a layered set of direction words: a core layer of 4-5, together with a marginal layer of at most 15.

**Planned upstream localization layer**: before divergence, the system plans for a small language model (Qwen3.5:2B) to perform semantic localization first — clarifying direction and annotating landing points, without generating any creative content (consistent with the LLM's standing responsibility boundary in P1 of "marking direction, marking QKV, and splitting dialogue"). The current pure dictionary/vector localization chain is the no-LLM route (Route 1); Routes 2/3/C, which place the LLM before/after/on both sides of SWOW, have been implemented in the lab but not merged into the mainline (the three-route architecture is detailed in Chapter 3, Section 3.1.1). Everything described below in this section is the current vocabulary-based path.

---

### 4.2.1 SWOW QKV Pool Intersection (Node-2)

#### Academic Basis

SWOW (Small World of Words) is a large-scale human free-association network built by De Deyne et al. (2019) at KU Leuven, Belgium. The Chinese version SWOW-ZH24 contains 10,024 cue words, each cue word associated with multiple response words and their strengths.

Node-2's QKV pool-intersection divergence borrows the Query-Key-Value structure of the **attention mechanism** (Vaswani et al., 2017):
- Q = the NB300 centroid of the input words (query vector)
- K = the NB300 vectors of all 10,024 SWOW cues (key space)
- V = the association response words of the intersected cues (value space)

It must be noted that this QKV structure is a **system-level proxy implementation**: by design, "QKV understanding" was judged to be a difficulty that only an LLM can handle, belonging to the core responsibility of the planned LLM annotation layer (H5 LoRA) — the responsibility boundary established by the designer is: within P1, the LLM is responsible only for QKV understanding, direction correction, and direction annotation, and undertakes no creative content generation; the basis for judging it a difficulty is the complexity of human language logic, which makes deep semantic parsing infeasible for pure word-list/vector methods. Node-2's NB centroid dot product serves only as an approximation of QKV intersection under the no-LLM route (Route 1); it does not imply that the QKV-understanding problem has been solved by a 300-dimensional vector dot product.

#### Formulas

**Centroid computation**:

$$\mathbf{c}_{\text{input}} = \frac{1}{\|\bar{\mathbf{v}}\|_2} \cdot \bar{\mathbf{v}}, \quad \bar{\mathbf{v}} = \frac{1}{|\mathcal{V}|} \sum_{w \in \text{inputWords}} \mathbf{v}_w$$

where $\mathbf{v}_w$ is the NB300 vector of word $w$, $\mathcal{V}$ is the set of input words that have vectors, and the result is L2-normalized.

**QKV intersection** (activated only with $\geq 2$ input words, to prevent single-word input from degenerating into per-word divergence):

$$\text{top cues} = \mathop{\text{topK}}\limits_{k=3} \left\{ \text{cue} \in \text{SWOW-ZH24} \mid \mathbf{c}_{\text{input}} \cdot \mathbf{v}_{\text{cue}} \right\}$$

Each intersected cue then calls swowDiverge to take 3 association words, which enter the pool after the six-level `_isNonInfoN2` filter.

**distance gate** (SWOW near-synonym filtering, promoted to default on):

$$\cos(\mathbf{v}_{\text{anchor}}, \mathbf{v}_{\text{assoc}}) \geq 0.85 \Rightarrow \text{discard}$$

This is a red line based on measured hard evidence: distance=1 synonym diffusion caused beilu recall 0.684 → 0.162 (-76%) and MRR -55%. Root cause: synonym-noise records ranked above genuine dialogue results.

#### Core Code

`divergeNode2` (the Node-2 SWOW divergence module):

```javascript
export function divergeNode2(inputWords, isNoise) {
  // NB300 centroid
  const vecs = inputWords.map(w => nbPool.get(w)).filter(Boolean);
  const inputCentroid = new Float32Array(300);
  for (const v of vecs) for (let i = 0; i < 300; i++) inputCentroid[i] += v[i];
  // L2 normalization
  let n = 0;
  for (let i = 0; i < 300; i++) { inputCentroid[i] /= vecs.length; n += inputCentroid[i] ** 2; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 300; i++) inputCentroid[i] /= n;

  // QKV pool intersection (>= 2 words)
  if (inputWords.length >= QKV_MIN_INPUTS && QKV_MODE !== "off") {
    // Q = inputCentroid, K = SWOW cue vectors
    // For each cue compute dot(inputCentroid, cueVec), sort, take top-QKV_TOP_CUES
    // Each intersected cue → swowDiverge(cue, QKV_CUE_ASSOC, opts)
    // Before pool entry, _isNonInfoN2 excludes non-information words
  }
  return { swowPool, inputCentroid, nbPool, trace_ };
}
```

#### Design Decisions

1. **Per-word divergence has been removed**: a system red line (established 2026-06-03) forbids per-word divergence — i.e., diverging each seed word independently and then simply summing the results. That operation produces superposition noise: highly connected association nodes are repeatedly activated by multiple seeds and systematically win, a mechanism cognate with the Fan Effect (Anderson, 1974). QKV pool intersection is holistic: it finds intersected cues starting from the semantic centroid of the input words, rather than diverging each word independently.
2. **QKV_MIN_INPUTS = 2**: with a single-word input, QKV degenerates into per-word divergence (the centroid equals that word's own vector), violating the prohibition; hence at least 2 input words are required.

---

### 4.2.2 NB300 Centroid Divergence

The NB300 centroid is the unified distance-metric infrastructure across the entire P1 pipeline, shared by multiple nodes:

**Centroid algorithm** (identical across all modules):

$$\mathbf{c} = \text{L2-normalize}\left(\frac{1}{|\mathcal{V}|}\sum_{w \in \mathcal{V}} \mathbf{v}_w^{300}\right)$$

ConceptNet Numberbatch (Speer et al., 2017) provides 300-dimensional dense vectors for 285K Chinese words, trained from a multi-source fusion of the ConceptNet knowledge graph + word2vec + GloVe, outperforming word vectors trained on any single corpus on lexical analogy tasks.

Consumers of the centroid include: Node-2 (the Query vector of SWOW QKV), Node-0 (semantic similarity of context sentences), the multi-route pool (the NB300 kNN path), Node-0-data (entry-level semantic similarity), and Node-7 (the optimal-semantic-distance-band determination of analogy divergence).

---

### 4.2.3 Six-Axis Face True Divergence (Node-3 axisDiverge)

#### Design Intent versus Implementation Deviation

Before developing the algorithm, the design semantics of six-axis localization must first be clarified: **the localization output of one axis for one word is a set of information points (the concept set the word associates with on that axis + its information range), not a single scalar score**. After localization results are transferred into the vocabulary, a word carries structured data of "information + information range" for downstream refinement and divergence to consume. The function of the six axes is **localization + refinement + divergence of information points**. This design — that on-axis localization yields a set of information points rather than a scalar — is consistent with conceptual spaces theory: a concept occupies a region, not a point, in semantic space (Gardenfors, 2000), and a single scalar projection necessarily loses the region structure.

The current implementation compresses each word on each axis into a single scalar (`allAxes[axis] = v`) and then ranks by scalar to select face words, which constitutes a dimensionality-reduced execution of the design (information loss) and is an identified item pending refactoring. What follows in this section describes the current code behavior.

#### Academic Basis

Node-3 localizes the input onto six major psycho-informatic axes (psychology, informatics, sociology, logic, linguistics, cognitive) and performs "true divergence" independently on each axis — starting from the high-weight face words of that axis, searching for semantic near-neighbors within the target space in NB300 space, and emitting new candidate words.

The target space consists of two parts:
- **AT terms**: terms in the activation_terms vocabulary carrying axes_47 coordinates
- **Bridge-library words**: physical-library words precomputed in p1_coord_bridge.json (sources: DLUT affective lexicon, narrative words, cn_daily everyday words, and per-Domain words)

The axis-decay formula comes from **rank-based decay** (Cormack et al., 2009, SIGIR; RRF):

$$\text{axisDecay}(\text{axis}) = e^{-\text{rank} \times \beta}$$

where rank is the position of each axis when sorted in descending order of face-word $\sum v$ (0 = the primary direction axis), and $\beta = 0.5$ (env P1_AXIS_DECAY_BETA).

#### Formulas

**Axis relevance and decay**:

$$\text{axisRelevance}(\text{axis}) = \sum_{w \in \text{face}(\text{axis})} v(w)$$

$$\text{axisRank}(\text{axis}) = \text{descending rank}(0 = \text{primary direction axis})$$

$$\text{axisDecay}(\text{axis}) = e^{-\text{axisRank} \times 0.5}$$

**Divergence cutoff condition**:

$$\frac{\text{axisRelevance}(\text{axis})}{\text{topRelevance}} < 0.40 \Rightarrow \text{axis does not diverge}$$

Axes whose relevance falls below 40% (P1_AXIS_CUTOFF) stop diverging, but their existing face words are retained (soft stop, not hard deletion).

**Axis-aware gating** (P1_AXIS_AWARE_DIVERGE, default on):

Candidate words are taken only from targets whose axes_47 primary group (argmax group) == the group of the current axis. For example, the psychology axis takes only terms dominated by psy_* groups, removing cross-axis contamination.

#### Core Code

`axisDiverge` (the Node-3 six-axis face module), target-space construction:

```javascript
// Target space = AT terms (with axes_47) + bridge-library words (precomputed axes_47)
// Each axis takes its top FACE_SEED_TOPK(3) face words as seeds
// For each seed: NB300 cosine search over the target space [minSim, maxSim]
// Axis-aware: when AXIS_AWARE_DIVERGE=on, only take targets with dom == this axis's group
```

`_computeAxisDecay` (the Node-3 six-axis face module):

```javascript
// axisRelevance[axis] = Sigma(v) of that axis's face words
// ranked = AXES sorted by axisRelevance descending
// axisDecay[axis] = exp(-rank * AXIS_DECAY_BETA(0.5))
// cutoffRatio[axis] = axisRelevance[axis] / topRelevance
// Axes with ratio >= AXIS_CUTOFF(0.40) may diverge
```

#### Design Decisions

1. **Why per-axis independent divergence rather than global divergence?** Under global divergence, candidates of the primary direction axis would occupy all slots, and candidates from secondary but valuable axes (e.g., the sociology axis when the user mentions pressure) could not enter the output. Per-axis divergence guarantees that every direction has candidates participating in subsequent voting.
2. **Why decay rather than hard truncation?** $e^{-\text{rank} \times 0.5}$ equals 1.0 at rank=0, approximately 0.37 at rank=2, and approximately 0.14 at rank=4 — distant axes are small but never zero, preserving a channel for weak signals.
3. **The necessity of the bridge library**: the coverage of the AT term library is limited (words outside AT, such as DLUT affective words, are not in the term library); the bridge library provides precomputed axes_47 coordinates for these words, enabling them to participate in subsequent spatial voting.

---

### 4.2.4 47-Sub-Axis Coordinate Hits (Node-4)

**Design positioning**: the 6 primary axes give a word's coarse localization (which disciplinary direction it falls into), while the 47 sub-axes characterize the semantic rate of change along each fine-grained direction within that coarse localization, undertaking directional refinement and driving directed divergence and expanded output. The two-level axis system then connects to the external resource layer (SWOW / ConceptNet / Numberbatch / Cilin / CFN, etc.), forming the multi-layer interconnected structure "6 axes → 47 sub-axes → resources": word activation propagates through the levels and aggregates additively, being localized, refined, and diverged level by level.

Node-4 takes the coordinate-hit results of the 47 sub-axes (such as psy_therapy, info_frontend, soc_interpersonal, etc.; in practice already expanded to 59 axes including the 12 cross-disciplinary semantic/perceptual dimensions sem_*/sm_* appended in C1) as activation signals, supplementing face words for which AT lookup finds no coordinates.

**Consumption path**: Node-4's witnesses (which words hit each sub-axis) are inverted in transfer into per-word activation coordinates `_wordActCoord`, so that face words originally lacking AT coordinates acquire sub-axis coordinates genuinely activated in the current round, and can thus participate in Node-6 spatial voting.

**Coordinate supplementation priority**: AT (native) > Node-4 activation (genuine hits this round) > bridge precomputation (offline nearest-neighbor projection). The three are mutually exclusive, each handling face words from a different source.

---

### 4.2.5 IDW Spatial Voting (Node-6)

#### Academic Basis

Node-6 is the **primary ranking layer** of the P1 pipeline — all information-pool words converge here into one multi-dimensional space, and the ranking of direction-word candidates is determined by many-to-one accumulative voting weighted by IDW (Inverse Distance Weighting, Shepard 1968).

IDW is a classic spatial-interpolation method from geostatistics; the original formula proposed by Shepard (1968) is $w_i = 1/d_i^p$. P1 adopts the variant $\text{idw} = 1/(1 + d^2 \cdot \text{steep})$, using the steep parameter to control decay steepness.

The design principle followed by temperature-scaled radius scoping is: the temperature parameter defines, in vector space, a geometric search circle centered on the input centroid, and candidates are filtered by their distance from the center — candidates that are too near or too far are both suppressed, and only candidates within the intermediate band participate effectively in voting. This is consistent with the core idea of Mednick's (1962) remote association theory — creative association resides in the "not-too-near, not-too-far" optimal semantic distance band (i.e., the Goldilocks zone of Section 4.1.1); the temperature's modulation of search scope follows the temperature semantics of the Boltzmann distribution (see Chapter 2, Section 2.14).

#### Formulas

**IDW-weighted voting**:

$$\text{idw}(d) = \frac{1}{1 + d^2 \cdot S}$$

where $d = 1 - \cos(\mathbf{a}, \mathbf{b})$ (spatial distance), and $S$ = the IDW steepness parameter (default 10, env P1_NODE6_IDW_STEEPNESS).

**Vote accumulation** (purely additive throughout; no division by N, no multiplicative chain):

$$\text{totalVote}(t) = \sum_{i \in \text{candidates}} w_i \cdot \text{idw}(d_{i \to t})$$

where $w_i$ = the score of candidate word $i$ (from Node-3 face weights).

This voting mechanism follows three hard-rule-level design principles: (1) **spatialized convergence** — all candidates converge into the same vector space, and voting is completed by the distributional shape of content in that space, not by pairwise hard matching between paths; (2) **additive fusion** — vote values are accumulated rather than multiplied, avoiding the AND-gate collapse of multiplicative chains (corresponding to the OR-gate semantics of CombSUM, Fox & Shaw, 1994); (3) **in-circle matching, out-of-circle decay, no averaging** — matching is delimited by a distance band (implemented as continuous IDW decay rather than hard exclusion), and the accumulated value is not divided by the number of votes, guaranteeing that contributions from multiple evidence sources accumulate monotonically (corresponding to the many-to-one accumulative voting paradigm of the Hough transform, Hough, 1962).

**Temperature tiers**:

$$T = \begin{cases} 1.5 & |\text{inputWords}| < 5 \quad \text{(short sentence, high temperature, large circle)} \\ 0.7 & |\text{inputWords}| > 10 \quad \text{(long sentence, low temperature, small circle)} \\ 1.0 & \text{otherwise} \end{cases}$$

**Geometric circle radius** (scaled by temperature):

$$r = r_{\text{base}} \times T, \quad r_{\text{base}} = 0.12$$

Inside the circle ($d \leq r$): the match is retained; outside the circle ($d > r$): no hard deletion — the natural IDW decay drives distant contributions toward zero.

**Anchor extraction (multiple density peaks + NoveltyBonus)**:

$$\text{effDensity}(v) = \text{totalVote}(v) \times \frac{1}{\sqrt{\text{sameAxisCount} + 1}}$$

The NoveltyBonus formula originates from design MD No. 82, L61: the more anchors already selected within the same axis, the lower the novelty bonus of subsequent same-axis candidates → natural down-weighting; ties are pulled apart without a hard threshold.

Density peaks are taken per axis group, implementing the framework's multi-anchor requirement — preventing all anchors from concentrating in a single semantic direction (the root cause of over-generic terms).

#### Core Code

`spaceVote` (the Node-6 spatial voting module), the main voting loop:

```javascript
for (const cand of candidates) {
  const src = _prepSource(cand);
  if (!src) { dim0Skip++; continue; }
  const w = cand.score != null ? cand.score : 0.1;
  for (const tgt of targets) {
    const { cos, dim } = _cosine(src.vec, src.norm, src.dim, tgt);
    if (dim === 0) continue;
    const d = 1 - cos;
    if (cos < o.circle.voteCosFloor) continue;  // too far: no vote
    const inCircle = d <= radius;
    const idw = 1 / (1 + d * d * _P1_NODE6_IDW_STEEPNESS);
    let vote = w * idw;                          // additive vote
    // Domain-signal bonus (additive term, not multiplicative)
    if (domainSignals) { vote += domainBonus; }
    rec.totalVote += vote;                       // accumulate, no /N
    if (inCircle) rec.voterCount++;
  }
}
```

#### Design Decisions

1. **baseRadius does not control the vote-value distribution**: a 200-case A/B experiment confirmed that radius does not change vote values; inCircle affects only ranking/anchor filtering — 0.09 is approximately equal to 0.12, while 0.18 causes persistent-output degradation. What actually controls the vote-value distribution is IDW_STEEPNESS.
2. **CN relation-edge voting as a parallel channel**: it shares the same accumulator as the 47D spatial voting; CN votes are likewise $w \times \text{cnVoteWeight}$ (weight 0.5). The dual channels run in parallel without replacement.
3. **Rejection of multiplicative-chain patches**: a code comment explicitly states "if the results look wrong, never add score*=X / vote*= quality coefficients as a patch" — chained multiplication = hard matching = a direct violation of the additive-fusion hard rule.

---

### 4.2.6 Five Paths of Second-Stage Divergence (Node-7)

Node-7 sits after Node-6 spatial voting (primary ranking) and before Node-9 (direction-word selection); it is P1's **first incremental divergence layer**. Five paths expand the candidate word pool from different angles and merge additively into Node-9's voting, without replacing Node-9's own Hough voting.

All five paths share:
- `_n7TermMap`: the deduplication map (including words already present in face/Node-6)
- `_faceMed`: the face median scale (the unified normalization baseline)
- `_n7Push`: the unified push helper, normalizing raw scores to the face median scale

#### Path 1: PPR (Personalized PageRank Multi-Hop Divergence)

**Academic basis**: Topic-Sensitive PageRank (Haveliwala, 2002, WWW) + HippoRAG (Gutierrez et al., 2024, arXiv:2405.14831).

**Formula**:

$$\mathbf{r}^{(t+1)} = (1 - \alpha) \cdot A \cdot \mathbf{r}^{(t)} + \alpha \cdot \mathbf{s}$$

Converged solution: $\mathbf{r}^* = \alpha (I - (1 - \alpha) A)^{-1} \mathbf{s}$

where $A$ is the column-normalized adjacency matrix, $\mathbf{s}$ is the personalization vector (one-hot over seed words), $\alpha = 0.15$, converging in 15 iterations.

**KG construction** (`_buildKG`):
- Nodes: T: (AT terms) / C: (concepts) / W: (trigger words)
- Edges: T ↔ C (the first 8 concepts of a term); W ↔ T (trigger→term in TI); C ↔ C (CN inter-concept relations)

**Seed selection**: a 200-case A/B experiment ruled against the anchors version (a stable anchor set caused the same batch of words to recur persistently; airp persistent-output rate 86%); the words version was retained as the default — seed = input words = the per-case source of variation, naturally diverse.

**Scale alignment**: raw PPR scores (~0.003-0.067) are 10-100 times smaller than face words (median 0.26-0.73); they must be linearly normalized to the face median scale by relative rank.

**Core code** (`_runPPR`, the Transfer module):

```javascript
function _runPPR(graph, seedNodes, alpha, maxIter) {
  let scores = new Map();
  for (const s of seedArr) if (graph.has(s)) scores.set(s, teleport(s));
  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Map();
    for (const s of seedArr) if (graph.has(s)) next.set(s, (next.get(s) || 0) + alpha * teleport(s));
    for (const [node, score] of scores) {
      const neighbors = graph.get(node);
      if (!neighbors || neighbors.size === 0) continue;
      const share = (1 - alpha) * score / neighbors.size;
      for (const nb of neighbors) next.set(nb, (next.get(nb) || 0) + share);
    }
    scores = next;
  }
  return scores;
}
```

#### Path 2: hop2 (Two-Hop Divergence)

**Academic basis**: spreading activation theory (Collins & Loftus, 1975, Psychological Review, 82:407-428).

**Algorithm**: Node-6 anchors → concepts → CN relation words/concepts → then look up TI → AT terms. PPR walks only paths inside the KG; hop2 supplements paths outside the KG.

$$\text{score}(w) = \sum_{\text{seed} \to c \to w} e(\text{seed}, c) \cdot \gamma \cdot I_{\text{disc}} \cdot \cos_w$$

where $\gamma = 0.75$ (per-hop decay), $I_{\text{disc}}$ = 1.0 for cross-axis / 0.5 for same-axis (discipline-switch bonus), and $\cos_w$ = NB cosine anti-noise diffusion (< 0.05 → *0.1, < 0.1 → *0.3). Per-bridge-word cap = 2 hits (limiting repeated tallying by a single bridge word, suppressing vote accumulation along synonymous paths), and over-generic-term exclusion (SWOW in-degree > 150).

#### Path 3: causal Attribution Divergence

**Academic basis**: ConceptNet (Speer & Havasi, 2012, AAAI) + ATOMIC (Hwang et al., 2021, AAAI, arXiv:2010.05953).

**Algorithm**: Node-6 anchors → concepts → CN causal relation chains (Causes / HasProperty / CapableOf / MotivatedByGoal) → TI → AT terms. Path-relay down-weighting: already-covered dim *0.5; when the same axis has > 3 terms, *0.7.

$$\text{raw}(w) = \text{seedW} \times \gamma_C \times I_{\text{disc}} \times \text{relayWeight}$$

$\gamma_C = 0.75$, causalCap = 20.

#### Path 4: analogy Divergence

**Academic basis**: Structure-Mapping Theory (Gentner, 1983, Cognitive Science, 7:155-170) + Information Bottleneck (Tishby et al., 1999, physics/0004057). The design definition of analogy divergence is cross-domain structural isomorphism: different manifestations of the same abstract relational skeleton in different disciplinary domains are mutual analogies. This is consistent with the core claim of Structure-Mapping Theory — analogy is a mapping of relational structure, not similarity of surface attributes (Gentner, 1983).

**Algorithm**: primary-axis anchor NB vectors → other-axis AT terms, NB cosine optimal band [0.2, 0.7]; bidirectional (primary axis → secondary axes + secondary axes → primary axis). (Note: this analogy-path optimal band [0.2, 0.7] and the recall-side Goldilocks optimal semantic distance band [0.25, 0.70] (see Section 4.1.1) are two independent parameters, both in cosine-similarity terms; do not conflate them with the "semantic distance" convention d = 1 − cos.)

**Inverted-U optimal-band gating**:

$$\text{cosWeight}(\cos) = \begin{cases} 0.1 & \cos < 0.1 \quad \text{(too far: not collected)} \\ 0.3 & 0.1 \leq \cos < 0.2 \\ 1.0 & 0.2 \leq \cos \leq 0.7 \quad \text{(optimal band)} \\ 0.3 & \cos > 0.7 \quad \text{(too near: redundant)} \end{cases}$$

**ranked mode** (judged positive and promoted in a 200-case A/B on 2026-07-03): collect all → sort by rawW descending → per-anchor cap (3) → truncate at ANCAP (15). This solves the old version's problem of a single anchor filling the entire global quota (the first anchor with an NB vector would scan the whole list and fill the global cap — a variant of per-word divergence).

#### Path 5: Six-Degree Path (BFS Cross-Domain Divergence)

**Academic basis**: the small-world phenomenon (Milgram, 1967) — any two people in a social network are on average reachable in six steps. The design unifies cross-frame analogy with the six-degree path: cross-domain structural association is modeled as a multi-hop reachability problem on the concept network — two semantically distant disciplinary concepts can be bridged through a few intermediate concepts within a small number of hops. This design also echoes weak-tie theory (Granovetter, 1973): cross-domain bridging edges (weak ties) are more likely than intra-domain strong ties to introduce new information.

**Algorithm**: Node-6 anchors → concepts → CN all-relation (not causal-only) 1-2 hops → AT terms.

$$\text{pathDecay} = \gamma \times I_{\text{disc}} \times \text{HOP\_DECAY}[\text{hop}]$$

where $\gamma = 0.75$, HOP_DECAY = [1.0, 0.4, 0.1], and pathDecay < 0.15 self-terminates.

**Cross-domain bonus** (SixDegreeBonus):

$$\text{SixBonus} = \min(1.6,\ 1.0 + 0.2 \times (\text{domainCount} - 1))$$

Key implementation detail: an **independent _sdSeen** is used for walk deduplication — if _n7TermMap were shared, 98.9% of AT words would already be claimed by other paths → output constantly 0. The walk uses _sdSeen (able to pass through already-seen words to find cross-domain new words), while push still dedupes against _n7TermMap (avoiding duplicate votes within the pool).

sdCap = 30.

---

## 4.3 Self-Update Mechanisms

P1's self-update/self-learning is a **three-layer architecture**: the real-time layer (asynchronous disk writes after each dialogue round), the consolidation layer (P9 meta-AI batch calibration), and the hot-swap layer (30-second mtime polling that detects vocabulary changes and reloads automatically).

---

### 4.3.1 Axis Statistics Accumulation accumulateAxisStats

#### Trigger Timing

Called asynchronously, fire-and-forget, after `runPipeline()` of the Pipeline module completes.

#### Algorithm

The self-learning module (axis statistics accumulation):

```javascript
// Called after each dialogue round's P1 recall
// Read/modify/write vocab/user/axis_stats.json
// schema: {axis: {sum, count, avg}}
// Memories cited by the main AI get weight x2 ("what the main AI actually selected better indicates the axis is useful")
// Serialized via withFileLock (eliminating concurrent lost-updates)
```

Accumulates usage statistics per axis — citation count, weighted total score, and running average. Read by the P9 calibration layer to determine which axes are frequently activated in this user's actual dialogues.

---

### 4.3.2 Word-Frequency Learning accumulateWordFreq

#### Algorithm

The self-learning module (word-frequency learning part) simultaneously accumulates three files:

1. **word_freq.json**: `{word: {c: count, t: day ordinal}}`
   - Records the occurrence frequency of the user's input words
   - Consumer side: frequently used words are up-weighted during P1 divergence (the user's high-frequency input words move forward in ranking)

2. **user_cooccur.json**: `{"w1|w2": count}`
   - Adjacent-word co-occurrence pair statistics
   - Used for per-user co-occurrence supplementation

3. **new_words.json**: `{word: {count, first}}`
   - Detection of words missing from the P1 vocabulary (maxNewWords=500)
   - For P9 to supplement new words into the vocabulary via online lookup

**Word-frequency boost formula** (`userFreqBoost`, the self-learning module):

$$\text{boost}(w) = \min(0.3,\ \log(1 + \text{count}) \times 0.1)$$

Sublinear TF damping with an upper bound of 0.3 guarantees that user word frequency serves only as a secondary bonus and does not dominate ranking. When consumed in the dLex dimension, it acts as a $(1 + \text{boost})$ multiplier, boosting by at most 30%.

The design reference for this mechanism is the user word-frequency memory of input-method editors: words the user inputs frequently are continuously recorded and up-weighted in subsequent ranking. Its cognitive-science counterpart is ACT-R base-level activation — the activation value of a memory unit accumulates with usage frequency and recency (Anderson et al., 2004); this mechanism realizes an engineering form of the same idea via sublinear TF damping.

---

### 4.3.3 P9 Calibration Layer calibrateAxisWeights

#### Algorithm

The self-learning module (P9 calibration part):

$$w_{\text{new}}(\text{axis}) = w_{\text{old}}(\text{axis}) \times (1 - \eta) + w_{\text{target}}(\text{axis}) \times \eta$$

where:
- $\eta = 0.3$ (learning rate: the weight of the new statistical data)
- $w_{\text{target}} = \max\left(0.5,\ \min\left(2.0,\ \frac{\text{stat.avg}}{\text{globalMean}}\right)\right)$ (target weight: the axis's statistical mean / the global mean, clamped to [0.5, 2.0] to prevent extremes)
- $\text{minSamples} = 20$ (the old value is retained when data are insufficient)

Produces `vocab/user/axis_weights.json`, consumed by the per-axis weights of P1.

This is an **exponential moving average** (EMA) update mechanism, letting axis weights converge smoothly toward the user's actual usage pattern, while the upper and lower bounds guard against overfitting.

---

### 4.3.4 Hot Reloading via mtime Polling

#### Mechanism

The core logic in the Pipeline module that detects mtime changes of vocabulary files and triggers cascading cache clearing:

```javascript
const _HOT_RELOAD_INTERVAL = Number(process.env.P1_HOT_RELOAD_INTERVAL) || 30000;

function _checkHotReload(mode) {
  if (now - _lastHotReloadCheck < _HOT_RELOAD_INTERVAL) return; // 30s throttle
  const files = [`activation_terms_${m}.json`, `transfer_index_${m}.json`];
  for (const name of files) {
    const mt = fs.statSync(fp).mtimeMs;
    if (prev !== undefined && prev !== mt) dirty = true;
  }
  if (dirty) {
    clearTransferCaches(); // Cascading clear of all production caches
  }
}
```

The mtime of the AT/TI vocabulary files is checked every 30 seconds. On change → cascading cache clear → the next getter automatically reloads the new vocabulary. It takes effect without a restart.

**Cascading cache-clear chain**: `clearTransferCaches()` → clear AT/TI caches inside transfer + clear the axis cache + clear the recall cache + clear the bridge cache + clear the polarity cache.

This mechanism implements the offline-online division of labor from the design plan: P9 produces new vocabularies via offline batch processing, while the P1 runtime side perceives changes via mtime polling and performs cascading cache clearing and reloading, achieving vocabulary updates without downtime.

**Overview of the self-update system**. The table below summarizes the five categories of mechanisms — real-time layer, consolidation layer, hot-swap layer, offline layer, and feedback layer — with their respective triggers and read/write relations:

| Layer | Mechanism | Trigger | Writes | Read/consumed by |
|---|------|------|------|---------|
| Real-time layer | accumulateAxisStats | Async after each runPipeline | axis_stats.json | P9 calibration |
| Real-time layer | accumulateWordFreq | Async after each runPipeline | word_freq.json etc. | userFreqBoost up-weighting |
| Consolidation layer | calibrateAxisWeights | Invoked by the P9 meta-AI | axis_weights.json | Per-axis weights of P1 |
| Hot-swap layer | 30s mtime polling | At each runPipeline entry | -- | Vocabulary change → full clear and reload |
| Hot-swap layer | vocabPacks mtime signature | memoryRecall | -- | Pack change → cache clear and reload |
| Hot-swap layer | coord-bridge clearBridgeCache | Pipeline cache-clear cascade | -- | Bridge-vocabulary change → index rebuild |
| Offline layer | P9 batch producing new vocabularies | Externally triggered | AT/TI/*.json | Detected by hot-swap polling |
| Feedback layer | Typing-style three-level activation | memoryRecall | -- | The user's high-frequency words automatically enter the recall side |

**Gate**: enabled when env `P1_SELF_LEARN` != "off" (default on).

---

### 4.3.5 Frequency Feedback Loop (ACT-R Frequency Decay)

The Transfer module maintains a cross-session cumulative `freq_stats.json`, recording how many times each term has been selected as a direction word. High-frequency terms are automatically down-weighted, preventing the same words from always appearing when the same user repeatedly inputs similar topics.

$$\text{freqDecay}(w) = \max\left(0.15,\ \frac{1}{1 + 0.15 \times (\text{count}(w) - 1)}\right)$$

The designer specified ACT-R frequency decay as the theoretical direction (Anderson, 1993); the specific formula and coefficients are starting values fitted at the implementation level.

During evaluation/consecutive runs, the frequency feedback loop can be disabled via `P1_DISABLE_FREQ=1`, making consecutive runs on the same input produce fully identical output (a precondition for case-by-case comparison across 800 cases).

**Atomic-write protection** (`_saveFreqStats`): a unique tmp name (pid + time + random) → atomic replacement via rename. In-process writes are serialized (the `_freqWriteInFlight` flag), preventing interleaving from multiple overlapping high-frequency writeFile calls.

This was fixed from an actual failure (root cause of the T33 recurrence: the old fixed ".tmp" name was shared by multiple processes → interleaved contamination → rename installed a corrupted file).

---

## Chapter Summary

The recall and divergence algorithm system of the P1 pipeline exhibits several design principles that run throughout:

1. **Additive, never multiplicative**: from CombSUM pool merging to IDW spatial voting to second-stage divergence merging, the entire chain is purely additive accumulation with no multiplicative chains — a zero in any single dimension cannot collapse the whole.

2. **Soft down-weighting, no hard deletion**: from the Goldilocks ibFactor to BCC soft down-weighting to axis decay, all signals are down-weighted through continuous functions rather than hard-deleted by binary thresholds — preserving the channel for marginally valuable weak signals.

3. **Independent routes merged afterward**: four recall routes, six independently diverging axes, five paths of second-stage divergence — each path produces output independently before entering spatial voting together, preventing any single path from dominating.

4. **Multiple spatial anchors, no collapse**: the multiple density peaks of IDW voting + NoveltyBonus ensure that anchors are distributed across multiple semantic directions, preventing all anchors from concentrating in a single semantic direction (the root cause of over-generic terms).

5. **Full parameter env-ization**: every magic number can be A/B-tested through environment variables without code changes, combined with full evaluation sets of 200-800 cases for experiment-driven parameter setting.
