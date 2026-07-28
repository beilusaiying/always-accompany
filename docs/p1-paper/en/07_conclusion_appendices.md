# Chapter 8: Discussion and Limitations

> This chapter offers a candid discussion of the current limitations of the P1 system, including noise in the evaluation methodology, the English-language performance bottleneck, lexicon maintenance costs, and the potential for complementarity with LLM-based approaches.

## 8.1 Limitations of the Evaluation Methodology

This study employs Gemini-3.1-flash-lite-preview as an automated scorer, rating P1 outputs on a 1-5 scale across four dimensions (direction accuracy, helpfulness, strategy match, and emotion coverage). While this method offers reproducibility and scalability, it suffers from the following systematic limitations:

**Significant scoring variance.** The v34 experiment exposed a severe noise problem in the scorer: re-scoring with a lexicon identical to that of v32 caused the historical score of 3.6 to drop to 2.84, with variance as high as ±0.7. Across three repeated scoring rounds on the 38-case standard set, the median per-case standard deviation was 0.3536, and 18.4% of cases had a standard deviation exceeding 0.5. This implies that inter-version improvements smaller than 0.3 are not statistically significant—the -0.010 from v21 to v22 and the +0.030 from v23 to v24 both fall within the noise range.

**Language and academic bias.** The automated scorer may assign higher scores to outputs containing "academic-sounding" terminology, may understand Chinese terms less precisely than English terms, and tends to favor outputs containing more terms. These biases are difficult to eliminate through simple prompt adjustments.

**Lack of large-scale human-annotation calibration.** This study did not conduct systematic human-annotation experiments to calibrate the biases of the automated scorer. Although deterministic proxy metrics (number of B2-mechanism-triggerable cases, UDRIL routing distribution, subclass activation distribution, emotion polarity distribution, etc.) were introduced for cross-validation, these metrics measure system behavior rather than output quality and cannot fully substitute for human evaluation.

**Overfitting risk on the standard set.** There is a significant gap of about 1.0 point between the score on the 38-case standard set (approximately 3.5) and the score on the 600-case single-turn large-scale dataset (approximately 2.4-2.6), indicating an overfitting risk from iterative optimization on the small standard set. Inter-version improvements may be amplified on the standard set while being diluted in generalized scenarios.

To address these limitations, this study adopted several mitigation measures: averaging over multiple scoring rounds, cross-validation with deterministic proxy metrics, and six improvements at the evaluation-metric layer (position swapping, score explanations, blind-review hashing, quantile statistics, worst-five-case analysis, and robustness metrics). However, these measures are mitigations rather than cures; future work should introduce large-scale human annotation and multi-evaluator cross-validation to improve the credibility of the evaluation.

## 8.2 English-Language Performance Bottleneck

The P1 system exhibits a significant performance gap between Chinese and English. On the 600-case single-turn dataset, the average English score is about 0.56-0.80 points lower than the Chinese score, with a consistent Chinese advantage across all four dimensions: direction accuracy gap -0.76, helpfulness gap -0.64, strategy match gap -0.56, and emotion coverage gap -0.80.

**Root-cause chain analysis:**

First, asymmetric lexicon coverage. The core term lexicon of approximately 2,127 entries is predominantly Chinese; English is mapped via transfer_index, and the mapping coverage is incomplete. The top-5 missed-recall English terms (validation 42 occurrences, empathy 35, inquiry 21, encouragement 21, reassurance 13) are all high-frequency strategy terms in English emotional-support dialogue, yet lack corresponding mappings in the P1 lexicon.

Second, insufficient precision in VAD polarity judgment. The continuous Valence-Arousal-Dominance estimation for English input is not sufficiently precise, and there is no secondary verification using the NRC-EmoLex 8 emotion categories. Approximately 30-40% of English negative emotions are inversely activated into positive direction words—this is the most severe systematic failure mode. For example, "I have a hard time getting out of bed in the morning" (a depressive symptom) was activated into gratitude_resonance and "celebrate together," a complete reversal of direction.

Third, quality differences between the Chinese and English SWOW data. SWOW-EN is superior to SWOW-ZH in association strength and coverage, but the Chinese terms in the transfer layer cannot fully exploit the divergence results of the English SWOW, creating a bottleneck of "high divergence quality but low transfer efficiency."

A design solution for this problem already exists (introducing secondary verification with the NRC-EmoLex 8 emotion categories, roughly 20 lines of code), but it has not been implemented as of v35. Improving English performance requires systematic multilingual lexicon construction and an upgrade of the polarity-judgment mechanism.

## 8.3 Lexicon Maintenance Costs

The P1 lexicon system comprises four mode-specific lexicons (chat/airp/code/work), totaling approximately 11,377 terms, 4,761 direction words, 6,616 information words, and 68,518 transfer_index trigger entries. Lexicon construction and maintenance incur the following costs:

**Construction cost.** Initial lexicon construction requires extracting specialized terms from real dialogue datasets (ESConv, EmoLLM, etc.), academic lexicons (NRC-VAD, the DLUT affective lexicon, etc.), and domain knowledge, which are admitted only after passing entry criteria (searchable, AI-recognizable, carrying consensus meaning, and being a direction word rather than a diagnostic word, route word, or colloquialism). Each batch of changes is limited to at most 20 terms, and activation_terms and transfer_index must be updated in sync. Across the 21 version iterations from v14 to v35, the experiment-line core term lexicon expanded from about 800 to about 2,127 entries; separately, the four-mode AT (Activation Terms) lexicon system (11,377 terms, a statistical scope distinct from the experiment-line core term lexicon) was completed on 2026-05-30. Every expansion required 200-case validation and manual review of actual outputs.

**Over-generic term governance cost.** As the lexicon grew, over-generic terms (generic words activated in 80%+ of scenarios) became a systematic problem. Governance measures evolved from simple eligible-tier demotion to the OVERUSED_PENALTY mechanism, the axis-mean algorithm, and large-medium-small three-tier routing, but each governance measure can introduce new patterns of rigidity. Experiments show that "quantity is sufficient; quality is the bottleneck"—three rounds comprising over seven thousand lexicon edits produced a delta of approximately zero, and the root cause of over-generic terms lies in the BLQ spatial mechanism rather than the lexicon itself.

**Dual-registry synchronization cost.** Keeping activation_terms and transfer_index synchronized is an iron rule of maintenance (learned through four failures); an omission on either side causes new terms to score zero hits or old terms to silently stop working. This synchronization currently relies on manual process discipline and lacks automated validation.

These costs limit, to some extent, P1's rapid expansion into new domains and new languages. The conclusion supported by ablation evidence is that the lexicon has reached a sufficiency threshold and the remaining bottleneck lies at the algorithmic-mechanism layer—in the long run, lexicon maintenance should yield priority to the optimization of algorithmic mechanisms (i.e., the "code first, lexicon second, LLM third" priority ordering; see Section 6.4.7).

## 8.4 Potential Complementarity with LLM-Based Approaches

P1's LLM-Free positioning does not exclude LLMs; rather, it provides cognitive front-loading for LLMs through zero-token external divergence. Three integration routes with LLMs are already reserved in the system design:

- **Route 1 (current production)**: Purely LLM-Free; the self-driven P1 independently completes divergence, and direction words are injected directly into the main LLM's context. Measured warm-invocation latency is approximately 300-500 ms (cold load approximately 9 s, against a design acceptance target of <=3 s), with zero token consumption.
- **Route 2**: The LLM intervenes before SWOW associative divergence, performing direction optimization, head identification, multi-head splitting, and hidden-content discovery, then hands the optimized results to SWOW divergence and the transferor.
- **Route 3**: The LLM intervenes after SWOW associative divergence, optimizing directions and transfer terms based on the context and the SWOW output before handing them to the transferor.

Routes 2/3 plan to adopt the local small model qwen3.5:2b as the LLM optimizer (preserving the zero-API-cost principle; for the accompanying fine-tuning work, see Sections 7.4.6 and 9.6). This LLM's role is bounded by an explicit design red line—it performs only discriminative tasks such as QKV optimization, multi-head identification, direction labeling, and typo and hidden-content discovery, and is prohibited from any creative output. This constraint ensures that LLM involvement does not compromise the determinism and auditability of P1's output.

The current relationship between the self-driven P1 and the AI P1 is serial—the self-driven P1 always runs first, and a confidence gate then decides whether the AI P1 provides serial enhancement (not replacement). This design allows LLMs to be introduced on demand to improve output quality when confidence is insufficient, while preserving the zero-token baseline.

Compared with pure LLM approaches (such as Chain-of-Thought and Tree-of-Thoughts), P1's core complementary value lies in providing an observable, debuggable, and reproducible divergence baseline via deterministic algorithms, so that the LLM receives a set of candidate cognitive directions before generation, rather than generating without any prior directional constraints. Experiments on Cognitive Priming in LLMs show that LLMs are indeed susceptible to semantic priming effects, and P1's direction words exert a verifiable priming effect on the main LLM.

## 8.5 Applicability of P1 Across Different LLMs

As an external pre-processing module for LLMs, P1's output (direction-word XML) is inserted at depth-0 of the LLM context via U-shaped injection (an arrangement exploiting the primacy and recency effects). In principle, this injection method is agnostic to the specific LLM—any autoregressive model that accepts textual context input can consume P1's direction-word output.

However, different LLMs may respond to direction words to different degrees:

**Context-window utilization.** P1's direction-word output is typically 3-6 terms, occupying very little context space (about 50-100 tokens). For models with small windows (e.g., 4K-8K), P1's lightweight output is an advantage; for models with extremely large windows (e.g., 1M), P1's "small vocabulary activates big modules" effect may be diluted by competition from other context signals.

**Semantic priming sensitivity.** Different LLMs vary in their sensitivity to semantic priming. Based on public research, models with larger parameter counts are generally more sensitive to fine-grained term priming. P1's direction words are designed under three admission criteria—searchable, seen by the model, and carrying consensus meaning—ensuring that direction words fall within high-frequency regions of mainstream LLM training data, maximizing activation reliability across models.

**Instruction-following capability.** P1's direction words are injected in XML format, and the main LLM must understand the semantic convention that "these terms are cognitive direction hints, not reply content." Models with stronger instruction-following capability (e.g., Claude, GPT-4) can better distinguish the guiding nature of direction words from the generative nature of reply content.

P1 currently operates with multiple LLM backends within the beilu system, but systematic cross-model comparison experiments are lacking. The difference in response quality across models given the same set of direction words is a direction worthy of in-depth study.

---

# Chapter 9: Future Work

## 9.1 Multilingual Extension

The current P1 system primarily supports Chinese; English support faces a significant bottleneck (about 0.7-0.9 points below Chinese). Future multilingual extension plans include:

**Japanese/Korean lexicon construction.** The beilu system's user base includes Japanese and Korean speakers, and P1's divergence mechanism requires lexicon support in those languages. For Japanese, the SWOW-JA association dataset and the jBATS analogy dataset can be used to build Japanese channels for associative and analogical divergence. For Korean, Korean SWOW data and the Korean sentiment lexicon (KNU-SL) can be used to extend polarity judgment and term mapping.

**Cross-lingual transfer_index.** The current transfer_index is dominated by monolingual entries, and cross-lingual mappings are incomplete. Multilingual word embeddings (ConceptNet Numberbatch itself contains multilingual vectors) could be introduced to enable cross-lingual term discovery and mapping, allowing English input to directly activate high-quality direction words in the Chinese term lexicon.

**Language-agnostic spatial mechanisms.** P1's core algorithms (spatial additive voting, axis decay, Hough-style many-to-one voting, etc.) do not themselves depend on any specific language; language dependence is concentrated in the lexicon layer and the transfer_index layer. Future work can further decouple the language-dependent layers from the algorithm layer, so that onboarding a new language requires only building the lexicon and mapping layers, without modifying the core algorithms.

## 9.2 End-to-End Evaluation

Current P1 evaluation measures only "the quality of P1's output direction words," not "the actual improvement in the main LLM's reply quality after direction-word injection." This is a key evaluation gap—P1's ultimate value lies not in the direction words themselves, but in their influence on the main LLM's generation behavior.

**P1 + LLM end-to-end evaluation plan:**
- Control group: the main LLM reads the raw user input and generates a reply directly
- Treatment group: the main LLM generates a reply after P1 injects direction words
- Evaluation dimensions: multi-dimensional coverage of the reply (whether it touches multiple facets of the user input), interdisciplinary depth (whether it offers cognitive angles the user did not explicitly mention), and conversational continuity (whether the user is more inclined to continue the dialogue)
- Data source: real dialogue logs from the beilu system, which can provide pre-/post-injection A/B comparisons

Technical challenges to be resolved include: automated evaluation of reply quality is more subjective and multi-dimensional than evaluation of direction-word quality, requiring a more refined evaluation framework and larger-scale human annotation.

## 9.3 Automatic Lexicon Expansion

Current lexicon construction and maintenance depend heavily on manual processes. The P9 self-upgrade loop has an initial design for an adaptive learning mechanism (silently running organization-layer presets every several rounds and reading dialogue logs to calibrate multi-axis weights), but the complete loop from "automatically discovering new terms" to "automatically admitting them into the lexicon" has not yet been realized.

Technical roadmap for **automatically discovering new terms from dialogue logs**:
1. Extract candidate terms via BM25 and TF-IDF from high-quality dialogues (positive user feedback, longer dialogue turns)
2. Use the Numberbatch vector space to judge the semantic distance between candidates and the existing lexicon—discard those too close (synonymous redundancy) and those too far (noise), keeping the sweet spot
3. Verify the "searchable" admission criterion via web search
4. Automatically generate transfer_index entries (based on co-occurring words in the dialogue context)
5. Gray-scale rollout (trial run at low weight), with formal admission after passing automated scoring verification

This plan must strictly obey the iron rule of "never let the AI fabricate terms out of thin air"—automatically expanded terms must originate from real dialogue data and public academic resources, not from free LLM generation.

## 9.4 Evaluation Methodology Improvements

**Human annotation + multi-evaluator cross-validation.** Build a gold-standard set annotated by domain experts (about 200-500 cases) covering both Chinese and English and all four dialogue modes, as a benchmark for calibrating the automated scorer. Simultaneously introduce multiple automated evaluators (e.g., different versions of Gemini, Claude, GPT-4) for cross-scoring, computing inter-evaluator agreement (Inter-Annotator Agreement, Cohen's Kappa) and evaluator-human correlation (Pearson/Spearman correlation coefficients).

**Adversarial evaluation.** Build adversarial test sets that specifically target P1's weaknesses, including: English negative emotions (testing the polarity-reversal problem), short-sentence/single-word inputs (testing the empty-output problem), mixed topics (testing the scenario-misjudgment problem), and technical discussions in code mode (testing the subclass-activation breakdown problem). These adversarial cases can systematically expose the boundaries of P1's failure modes.

**Longitudinal evaluation.** Conduct long-term tracking in real deployments of the beilu system, recording the influence of P1 direction words on user behavior—including changes in dialogue turn counts, frequency of user-initiated topic switches, and dialogue trajectories in which negative emotions turn positive. Such longitudinal data can provide a richer perspective on system value than single-shot scoring.

## 9.5 Real-Time Learning Enhancement

P1's current hot-swap self-learning (the typing mechanism) implements only user-level soft term-frequency boosting (`userBoost(word) = log(1+freq[word]) * 0.1`, capped at +0.3), with offline batch processing producing new lexicons that are then hot-loaded. Future directions for real-time learning enhancement include:

**Session-level dynamic weight adjustment.** Within a single conversation, adjust the weight priority of direction words in real time based on the effect of the main LLM's replies (whether the user responds positively, whether topic switches occur, whether negative feedback appears).

**Cross-user population-level term-frequency aggregation.** Aggregate term-frequency feedback from different users into a population-level term-popularity signal, so that high-frequency effective direction words receive global boosting and low-frequency ineffective direction words receive global demotion.

**Cold-start solution.** For new users or new topic domains, use population-level term popularity as an initial prior to quickly establish a personalized direction-word preference model.

## 9.6 Small-Model Front-End Localization Layer

Introducing a small language model (Qwen3.5:2B) as a semantic localization stage before the divergence phase is a planned but not yet implemented architectural upgrade. The small model performs only the localization function of "judging which axes/sub-axes the user input falls on"; divergence, voting, and ranking remain the responsibility of the lexicon pipeline—the main path stays LLM-Free, the small model is an optional front-end component, and when offline the system degrades to the pure-lexicon path. The accompanying fine-tuning route has completed its preliminary exploration: v45 8-Head LoRA (Qwen3.5-2B, eight discriminative heads H1-H8, 114,565 training rows, 7 hours 27 minutes of training, training completed on 2026-05-08; see Section 7.4.6) provides the training methodology and data foundation for multi-task discriminative fine-tuning at this layer; the negative-result LoRA reranker experiment (full-set 94 cases, total score -0.07, within the scorer's noise margin) delineates the benefit boundary of post-hoc LLM intervention. This small model likewise obeys the "no creative output" red line, performing only discriminative functions such as localization, QKV optimization, and multi-head identification.

In addition, the implementation-layer refactoring of six-axis localization falls within this direction: restoring the current dimensionality-reduced implementation of "one scalar per word per axis" to the design semantics of structured "multiple information points per axis" localization (information + information range), eliminating information loss (see the deviation notes in Chapters 3 and 4).

---

# Chapter 10: Conclusion

## 10.1 Review of Core Contributions

This paper proposes and implements P1—an LLM-Free front-loaded cognitive divergent recall engine—aimed at addressing the architectural absence of pre-generation divergent exploration in large language models. P1's core contributions are summarized as follows:

**First, we pose the problem of cognitive front-loaded divergence and present the first LLM-Free systematic solution.** We explicitly point out that the LLM's self-attention mechanism is essentially competitive normalization, and its architecture naturally tends toward contraction rather than divergence. As an external divergent thought chain, P1 completes multi-dimensional semantic divergent exploration before LLM generation—with zero token consumption, latency under 500 ms, and full white-box observability—providing the LLM with a set of candidate cognitive directions prior to generation.

**Second, we design and implement the Contraction-Divergence-Contraction (CDC) three-stage cognitive processing pipeline.** The pipeline integrates multidisciplinary theoretical foundations including spreading activation theory, structure-mapping theory, and information bottleneck theory, formalizing the human cognitive process of "first contracting to anchors, then diverging through association, then contracting into action" as a twelve-stage node pipeline. Through a two-pass divergence architecture (associative divergence, to spatial-voting narrowing, to cross-domain divergence, to many-to-one contraction), the pipeline realizes the complete cognitive processing chain from user input to direction words.

**Third, we propose the spatial additive voting mechanism and the BLQ multi-factor ranking algorithm.** We transfer the many-to-one voting paradigm of the Hough transform from computer vision to NLP direction-word generation, implementing additive accumulation voting via inverse distance weighting (IDW)—the design principle prohibits multiplicative chains throughout; in honest disclosure, the implemented Phase T fine-ranking was for a long time a 13-factor full-product chain, which has been identified as a pending correction that contradicts this design principle—combined with mechanisms including six-axis face divergence, temperature circling, sweet-spot distance control, lateral inhibition, and MMR quotas, achieving robust contraction from hundreds of divergence candidates to a handful of high-quality direction words. Condorcet's jury theorem provides a theoretical guarantee for the reliability of multi-source voting.

**Fourth, we establish a formalized evaluation framework for direction-word quality.** We propose original quality criteria such as "null-value terms" (words the main model could infer from the raw text alone, hence of zero value), "over-generic terms" (high-frequency generic words lacking specificity), and "red-line words" (four categories of hard-culled violations: route words, inductive words, subjective-experience words, and diagnostic words), and design a four-dimension scoring system (direction accuracy, helpfulness, strategy match, emotion coverage) and a five-dimension internal evaluation system (contextual connection, direction-versus-route distinction, direction-word quality, multi-head capture, analogical divergence) for the systematic evaluation of divergence output quality.

**Fifth, we open-source the complete system implementation and an approximately 61 GB multilingual cognitive resource library.** This includes the SWOW-ZH24 associative word network (10,024 cue words), ConceptNet Numberbatch multilingual word vectors (294,716 Chinese words + 516,782 English words, 300 dimensions, counted at load time), the ConceptNet inverted index (simplified edition, 256,032 words), the NRC-VAD v2 affective lexicon (54,801 words), and the DomainWordsDict domain lexicon (561,000 words across 69 domains), among 14 integrated resources and 44 integration-ready resources, along with the complete four-mode direction-word lexicon of 11,377 terms.

## 10.2 Key Experimental Findings

**Version evolution.** P1 iterated from the v14 baseline (overall = 1.555) to the historical peak at v29 (overall = 3.620; version span v14--v29, with 12 versions recorded with measurements in Table 7-1), achieving a +132.8% improvement in the overall score. In this process, we identified three key improvement levers:

1. Lexicon coverage is the first factor. From v14 to v21, the lexicon expanded from about 740 to 1,600 entries, delivering the largest single jump of +105.1% (overall from 1.555 to 3.190).
2. Over-generic term governance is the second factor. The OVERUSED_PENALTY mechanism in v27 reduced over-generic term occurrences from 139 to 27 (-81%), delivering a +0.260 overall improvement and bringing the system to its then-highest score of 3.540.
3. Algorithmic improvement (the axis-mean algorithm) is the third factor. The axis-mean algorithm in v26 eliminated the dominance of the cognitive/emotion dimensions over ranking, delivering a +0.160 improvement.

**Generalization capability.** The high score on the 38-case standard set (about 3.5) and the score on the 600-case single-turn large-scale dataset (about 2.4-2.6) differ by about 1.0 point, indicating an overfitting risk. The Chinese-English gap remains stable at 0.7-0.9 points, and English polarity reversal (negative emotion to positive-direction words) is the most severe systematic failure mode.

**Divergence quality.** On the beilu real dialogue dataset (N=300), P1's mean overall divergence score is approximately 0.73, with surprise reaching 0.97 and sceneMatch reaching 0.86, demonstrating the core characteristic of "high surprise coexisting with high scene match"—that is, the ability to diverge to semantically distant targets while retaining traceable association paths.

**Failure modes.** Five systematic failure modes were identified: English negative-emotion-to-positive-word reversal (about 30-40% of low-scoring English cases), cross-scenario high-frequency activation of over-generic terms (substantially mitigated after v27), empty output on short sentences (2%), scenario misjudgment (mode routing depends on term-frequency statistics), and complete failure in code mode (all 15 subclasses with zero hits). Among these, the fix for the English polarity-reversal problem has been designed (NRC-EmoLex secondary verification, roughly 20 lines of code) and is expected to deliver a +0.25 improvement for English.

## 10.3 Open-Source Commitment

The P1 system is released as open source under a layered licensing model:

- **Core code**: AGPL-3.0 license. Covers the implementation of all P1 pipeline nodes (tokenization, associative divergence, six-axis face divergence, sub-direction localization, spatial additive voting, many-to-one voting, red-line filtering, etc.) and the evaluation tools.
- **Documentation and lexicons**: CC BY-NC-SA 4.0 license. Covers the four-mode direction-word lexicons (activation_terms), the transfer index (transfer_index), design documents, and technical documents.

Third-party academic resources each retain their original licenses (see Appendix C for details).

P1 is the core subsystem of the beilu companion dialogue system. Through open-sourcing, we hope to provide the academic and open-source communities with a reproducible, extensible research baseline for cognitive front-loaded divergence, advancing the research direction of "cognitive preparation before LLM generation." The system's complete source code, lexicons, resource index, and experiment scripts are all available in the project repository.

---

# Appendices

## Appendix A: Complete Environment Variable Table

All behavioral switches of the P1 pipeline are controlled via environment variables (read once at process startup); lexicon data files are additionally governed by an mtime-polling hot-swap mechanism, so lexicon changes require no service restart. The following 33 environment variables cover node gating across the entire pipeline, from bracket dual-channel to white-box observability.

### A.1 Pre-Processing Layer

| Environment Variable | Default | Function |
|----------|--------|------|
| `P1_BRACKET` | `on` | Step-1 bracket dual-channel switch. When off, falls back to pure single-channel processing |
| `P1_BRACKET_MIN_LEN` | `4` | Exemption threshold for overly short brackets (character count); bracket content shorter than this is treated as formatting brackets rather than an emotional side channel |
| `P1_BRACKET_SEP` | `" "` | Separator for concatenating multiple side-channel fragments |
| `P1_NODE1_V2` | `on` | Enables the framework-version tokenization module tokenizeNode1 |

### A.2 Associative Divergence Layer

| Environment Variable | Default | Function |
|----------|--------|------|
| `P1_N2_SWOW_TOPK` | `6` | Number of SWOW association words per word. Controls the breadth of the first divergence |
| `P1_N2_SWOW_DISTANCE` | `on` | SWOW distance gating; near-synonyms with cosine >= 0.85 are filtered to prevent synonymous redundancy from spreading |
| `P1_N2_QKV` | `on` | QKV pool convergence divergence switch |
| `P1_N2_QKV_CUES` | `3` | Number of top cues in QKV processing |
| `P1_N2_QKV_ASSOC` | `3` | Number of association words per cue |

### A.3 Six-Axis and Spatial Layer

| Environment Variable | Default | Function |
|----------|--------|------|
| `P1_NODE3_FACE` | `on` | Six-axis face-output (not line) switch. When off, each axis degenerates to a single score rather than a multi-dimensional information face |
| `P1_AXIS_DECAY` | `on` | Axis decay switch. When off, all axes share equal weight rather than decreasing by relevance |
| `P1_DOMAIN_SIGNALS` | `on` | Domain signal aggregation switch |
| `P1_FACE_ANCHOR` | `on` | axisDiverge true-divergence switch |
| `P1_AXIS_AWARE_DIVERGE` | `on` | Axis-aware divergence, restricting the divergence range to the group's targets via positional gating |
| `P1_N4_UNIFY` | `on` | Node-4 key-name unification, mapping theoretical keys to standard FIELD keys |

### A.4 Transfer and Divergence Layer

| Environment Variable | Default | Function |
|----------|--------|------|
| `P1_NODE7_PPR` | on unless "0" | PPR (Personalized PageRank) multi-hop divergence switch |
| `P1_NODE7_HOP2` | on unless "0" | hop2 two-hop expansion switch |
| `P1_NODE7_CAUSAL` | on unless "0" | Causal-attribution divergence switch |
| `P1_NODE7_ANALOGY` | on unless "0" | Analogical divergence switch |
| `P1_NODE7_SIXDEG` | on unless "0" | Six-degree path divergence switch |

### A.5 Ranking and Output Layer

| Environment Variable | Default | Function |
|----------|--------|------|
| `P1_NODE9_LOC_VOTE` | `on` | Localization voting; 47D cosine participates in direction-word voting |
| `P1_NODE10_BLQ` | `on` | Node-10 BLQ fine-ranking switch |
| `P1_REDLINE_CULL` | `on` | Red-line hard-cull switch. When off, red-line words (route words / inductive words / subjective-experience words / diagnostic words) are not culled |

### A.6 Cross-Cutting Mechanisms

| Environment Variable | Default | Function |
|----------|--------|------|
| `P1_SELF_LEARN` | `on` | Self-learning write-to-disk switch. When on, terms frequently used by the user receive soft boosting |
| `P1_DATA_RECALL` | `off` | data three-layer broad-recall switch. Experimental stage, off by default |
| `P1_METADISCOURSE_TERMS` | `on` | Metadiscourse-term activation switch |
| `P1_FREQ_BOOST` | `on` | Per-user term-frequency soft-boosting switch |
| `P1_DISABLE_FREQ` | `off` | Disables the frequency feedback loop |
| `P1_PYRAMID` | `off` | Pyramid three-layer labeling switch. Optional feature, off by default |

### A.7 System Operations

| Environment Variable | Default | Function |
|----------|--------|------|
| `P1_HOT_RELOAD_INTERVAL` | `30000` (ms) | Hot-swap polling interval. Checks lexicon file modification times every 30 seconds; on change, clears cache and takes effect immediately |
| `P1_NODES_OFF` | `""` | Nodes forced onto the fallback path (comma-separated). Used for fault isolation and single-node degradation testing |
| `P1_RESOURCE_DIR` | `""` | Resource directory override path |
| `P1_WHITEBOX` | `""` | White-box observability filter. Fully on by default (an empty string means no filtering); can be set to observe only specific nodes |

### A.8 Gating Design Principles

1. **On by default (safe-on)**: The vast majority of functional switches are on by default; only `P1_DATA_RECALL` (experimental stage) and `P1_PYRAMID` (optional feature) default to off.
2. **Fallback via off (safe-off)**: Setting any switch to `off` reverts to the behavior prior to that node's rollout, guaranteeing backward compatibility.
3. **Startup read + lexicon hot-swap**: Environment variables are read once at process startup (changes require a process restart to take effect); lexicon data file updates take effect dynamically via mtime-polling hot-swap, without service restart.
4. **Node-level isolation**: `P1_NODES_OFF` allows a single node to be degraded to fallback empty-value output without stopping the service.

---

## Appendix B: P1 Glossary of Proprietary Terms

This appendix, sorted by Chinese pinyin, lists the core concepts and proprietary terms of the P1 system, providing Chinese-English correspondences and brief definitions.

### B.1 Core Concepts (48 items)

| No. | Term (Chinese) | Term (English) | Definition |
|------|-----------|-----------|---------|
| 1 | 0-token 原则 | Zero-Token Principle | The entire divergence step invokes no LLM, with zero token consumption throughout |
| 2 | 19 路发散 | 19-Route Spread Activation | The nineteen spreading-activation routes of Phase B (the finally implemented route set; each invocation triggers a subset depending on input characteristics) |
| 3 | BLQ | Beilu Linqing Quality | The candidate-quality scoring device inside the transferor, using CombSUM additive summation minus lateral-inhibition deductions |
| 4 | BLQ-Coord 多轴词坐标系统 | BLQ-Coord Multi-Axis Coordinate | A coordinate system representing each word as a structured sparse vector; the six disciplinary factors are different projections of the same coordinate space |
| 5 | K 桥接 | K Bridge | The bridging design of K in QKV, bridging memory-recall results into term linkage |
| 6 | P9 自升级闭环 | P9 Self-Upgrade Loop | An adaptive learning mechanism that calibrates multi-axis weights via daily-scan organization |
| 7 | QKV 池交汇发散 | QKV Pool Convergence Divergence | Q = centroid of input word vectors, K = associative-network cues, V = chained re-association of convergent cues producing divergence words (same name as, but distinct from, the LLM-layer QKV three-class labeling in Table 6-16 of Chapter 6) |
| 8 | SWOW 联想词网 | SWOW Associative Network | The data source of P1's core divergence engine, a lexical network based on large-scale human free-association experiments |
| 9 | U 型注入 | U-Shaped Injection | Placing the most important content at the beginning and end of the sequence, per the primacy and recency effects |
| 10 | YouSaid 空间 | YouSaid Space | A spatial design that projects the activation system from the output side to the input side |
| 11 | 白盒可观测 | White-Box Observability | The input, processing, and output of every node can be observed online |
| 12 | 擦边发散线 | Edge-Touching Divergence Line | An extremely low-threshold recall line serving divergence anchors |
| 13 | 大量擦边召回 | Massive Edge-Touching Recall | A low-threshold, high-volume, fuzzy recall strategy whose results serve only as anchors |
| 14 | 大中小三级路由 | Large-Medium-Small Routing | Replacing global scoring with three-tier routing over an inverted index, structurally governing over-generic terms |
| 15 | 点线面体 | Point-Line-Face-Body | P1's geometric model of processing levels: point = word, line = direction, face = type, body = multi-dimensional space |
| 16 | 断崖弃权 | Cliff Abandonment | Proactively truncating output when direction-word scores exhibit a cliff-like drop |
| 17 | 仿生三层架构 | Bionic Three-Layer Architecture | P1 = eyes, main model = brain, collaborating subagents = hands |
| 18 | 方向词 | Direction Word | P1's final product: a specialized-term seed contracted from multiple information words |
| 19 | 方向词种子 | Direction Word Seed | A direction word as a seed activating knowledge blocks in the main model (small vocabulary activates big modules) |
| 20 | 废词 | Null Word / Waste Word | A word the main model could infer from the raw text alone; of zero P1 value |
| 21 | 红线词 | Redline Word | Four categories of violating words hard-culled on hit: route words, inductive words, subjective-experience words, diagnostic words |
| 22 | 机制并行 | Mechanism Parallelism | Achieving mode differentiation by activating different combinations of mechanisms |
| 23 | 括号双信道 | Bracket Dual-Channel | Step-1 separates the main text (primary channel) from bracketed content (side channel) before tokenization |
| 24 | 冷层 | Cold Layer | Memories older than a month; long-term semantic memory triggered only by keywords |
| 25 | 两次发散架构 | Two-Pass Divergence Architecture | Divergence 1 (association) -> voting narrowing -> Divergence 2 (information words) -> many-to-one contraction (direction words) |
| 26 | 六度分隔 | Six Degrees of Separation | The hop-count constraint on divergence paths and the mechanism granting incremental rewards for cross-domain analogy |
| 27 | 六轴面发散 | Six-Axis Face Divergence | Six disciplinary axes each diverge independently in parallel, with each axis outputting a multi-dimensional "face" rather than a single score |
| 28 | 锚点 | Anchor Point | The starting point of divergence, jointly constituted by memory recall and the current dialogue context |
| 29 | 热插拔自学习 | Hot-Swap Self-Learning | A new lexicon file equals a new divergence axis, supporting runtime hot loading |
| 30 | 热层 | Hot Layer | Active memory; working memory injected in full every turn |
| 31 | 热/温/冷三层记忆 | Hot/Warm/Cold Three-Layer Memory | A memory architecture with the data layer stratified by activity level |
| 32 | 散词池 | Scattered Word Pool | The intermediate word collection produced by associative divergence, serving as input to subsequent spatial voting |
| 33 | 收拢-发散-收拢 | Contraction-Divergence-Contraction (CDC) | P1's overall skeleton: first contract to anchors via memory, then diverge through association, finally contract into direction words |
| 34 | 双线召回 | Dual-Line Recall | Two physically isolated recall channels: the ontology precise line and the edge-touching divergence line |
| 35 | 甜蜜区 | Sweet Spot | The optimal interval of divergence distance; both too near (synonymous redundancy) and too far (random noise) are undesirable |
| 36 | 外置的发散思维链 | External Divergent Thought Chain | P1's overall positioning: a processing node attached outside the LLM dedicated to divergence |
| 37 | 万金油 | Over-general Hub | A high-frequency generic word "touching on" most contexts yet lacking specificity; root causes are insufficient information / insufficient axes / unstable localization |
| 38 | 温层 | Warm Layer | Dialogue summaries from the past month; recent episodic memory recalled on demand |
| 39 | 温度 | Temperature | The parameter controlling the spread range from the anchor, drawing the divergence boundary circle |
| 40 | 五步标准链 | Five-Step Standard Chain | The five-step sequence of P1's spatial mechanism: six-axis parallel, pooling, scoring, localization, temperature-bounded spreading |
| 41 | 信息词 | Information Word | An intermediate product of divergence, not output directly; direction words are produced after many-to-one contraction |
| 42 | 信息池发散 | Information Pool Divergence | Superimposing the information of all words into one pool and diverging as a whole; per-word divergence followed by summation is prohibited |
| 43 | 自驱动 P1 | Self-Driven P1 | The pure-algorithm divergence engine independent of LLMs (0 tokens; word-level activation <1 ms, measured full-pipeline warm invocation approximately 300-500 ms) |
| 44 | AI P1 | AI P1 | The preset using an LLM for retrieval augmentation (1-3K tokens per invocation), running in series with the self-driven P1 |
| 45 | 子方向空间 / 47 子轴 | Sub-Direction Space / 47 Sub-Axes | The high-resolution direction coordinate space on the output side; localization only, no scoring |
| 46 | 空间相加投票 | Spatial Additive Voting | Additive voting within the pool (multiplicative chains prohibited), with IDW inverse distance weighting for additive accumulation voting |
| 47 | 轴衰减 | Axis Decay | Axes ranked in descending order of relevance decay exponentially (exp(-rank * beta)); distant axes never reach zero; the design semantics allocate roughly 80% weight to the primary direction and roughly 20% to secondary directions (see Table 6-13 of Chapter 6) |
| 48 | 转接 / 转接器 | Transfer / Transferor | The entire processing stage that converts scattered words into specialized vocabulary |

### B.2 Design Principles (18 items)

| No. | Principle (Chinese) | Principle (English) | Meaning |
|------|-----------|-----------|------|
| 1 | 给方向不给路线 | Direction Not Route | Provide only cognitive directions (e.g., "cognitive restructuring"), never concrete behavioral instructions (e.g., "go for a walk") |
| 2 | 量大擦边 | Massive Edge-Touching | Tolerate null-value terms; pursue high volume with correct direction |
| 3 | 吐面不吐线 | Output Face Not Line | Each axis outputs a multi-dimensional information face, not a single score line |
| 4 | 软过滤铁律 | Soft Filtering Iron Rule | Filtering should demote words (descending order) rather than make them disappear; direct skipping is prohibited |
| 5 | 小词汇激活大模块 | Small Vocab Activates Big Module | A single term, though small, points to an entire knowledge tree inside the main model |
| 6 | 灵光一现但有理有据 | Eureka With Evidence | The overall criterion of divergence quality |
| 7 | 机制并行运行串行 | Mechanism Parallel Run Serial | Differentiation is achieved by activating different combinations of mechanisms |
| 8 | 软隔离 | Soft Isolation | Demote only, never delete; distant axes contribute weakly but never zero |
| 9 | 加性即或门 | Additive = OR Gate | The design argument for additive scoring, opposing the AND gate of multiplicative chains where a single dimension can veto |
| 10 | 先联想再类比 | Association Before Analogy | A serial constraint preventing analogical drift |
| 11 | 先收拢再发散 | Contract Before Diverge | Establish anchors before diverging, preventing drift |
| 12 | 先学科后分布 | Discipline First Distribution Later | Axes run in parallel by discipline first, then merge to check associations |
| 13 | 空间不相乘 | Space Not Multiplication | The pool is spatial addition, not nonlinear multiplication |
| 14 | 四红线 | Four Redlines | No creation, no scoring, no projection, no influencing the system |
| 15 | 代码第一词库第二 LLM 第三 | Code First Vocab Second LLM Third | The priority ordering of optimization |
| 16 | 信号内化不外泄 | Signal Internalize Not Leak | Delete all vocabulary that the AI might misread as the user's subjective experience |
| 17 | 不代替用户表达 | Not Speak For User | Give directions, not routes or inducements; never speak for the user |
| 18 | 词库够了是代码的问题 | Vocab Enough Code Problem | Long-term optimization should yield priority to algorithmic-mechanism improvement |

### B.3 Algorithmic Components (14 items)

| No. | Term (Chinese/English) | Source | Use in P1 |
|------|-------------|------|--------------|
| 1 | CombSUM | Fox & Shaw 1994 | Weighted linear summation in BLQ |
| 2 | IDW 反距离加权 / Inverse Distance Weighting | Shepard 1968 | The core weighting formula of spatial additive voting |
| 3 | 侧抑制 / Lateral Inhibition | Classical neuroscience | Suppression of near-synonyms to preserve diversity |
| 4 | MMR 配额 / MMR Quota | Carbonell & Goldstein 1998 | Guarantees representative direction words per axis |
| 5 | 软地板 / Soft Floor | P1 original | A safety-net coefficient preventing hard zeroing when multiple gates stack deductions |
| 6 | 扇出惩罚 / Fan-out Penalty | ACT-R (Anderson 1974) | Demotion penalty for high-connectivity nodes |
| 7 | Hough 式多对一投票 | Hough 1962 | Multiple information words vote independently for the same direction word |
| 8 | 倒 U 型 / Inverted U-Shape | Tishby 1999 (Information Bottleneck) | The information-bottleneck shape in which intermediate distance carries the most divergence value |
| 9 | 温度画圆 / Temperature Circle | P1 original | The divergence boundary with the anchor as center and temperature as radius |
| 10 | Condorcet 陪审团定理 | Condorcet 1785 | Theoretical guarantee of the reliability of multi-source independent voting |
| 11 | 置信度闸门 / Confidence Gate | P1 original | Three-factor weighted decision on whether to inject into the main AI |
| 12 | 框架识别与跨框架类比 | Gentner 1983 SME | Extracting the relational skeleton and seeking isomorphs in other domains |
| 13 | 扩散激活 / Spreading Activation | Collins & Loftus 1975 | The theoretical foundation of P1's associative divergence |
| 14 | 交叉节点发现法 / Cross-Node Discovery | P1 original | Diverging concepts along at least three chains to find cross nodes as the true root |

### B.4 Vocabulary System (8 items)

| No. | Term | Meaning |
|------|------|------|
| 1 | 联想发散 (Associative Divergence) | Same-domain divergence expanding toward semantic neighbors |
| 2 | 类比发散 (Analogical Divergence) | Extracting the relational skeleton and seeking isomorphs across domains; the highest divergence value |
| 3 | 同性发散 (Homogeneous Divergence) | Expansion within the same domain; medium value |
| 4 | 认知激活块 (Cognitive Activation Block) | The direction-word/term block injected by mode in P1's XML output |
| 5 | 三纪元 (Three Epochs) | The architectural evolution of the P1 codebase: monolith -> three files -> node pipeline |
| 6 | 三条线路 (Three Route Options) | Differ only in the LLM optimizer's insertion point: Route 1 no LLM / Route 2 pre-positioned / Route 3 post-positioned |
| 7 | 组件态 (Component State) | The reserve state of algorithms implemented but not yet wired back into the main chain |
| 8 | 节点流水线 (Node Pipeline) | The current production architecture with modular orchestration |

---

## Appendix C: License Statement

### C.1 P1 Core Code License

The P1 system core code is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

This license requires:
- When modified code is provided as a network service, the source code must be made public
- Derivative works must adopt the same license
- Commercial use must comply with all terms of AGPL-3.0, or obtain a separate commercial license pursuant to Section C.3 (dual-licensing model)

The core code scope includes: the implementation of all P1 pipeline nodes, the evaluation tools, the hot-swap mechanism, and the white-box observability system.

### C.2 Documentation and Lexicon License

The P1 system's documentation, technical manuals, and direction-word lexicons are licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**.

This license requires:
- Attribution: appropriate credit must be given upon use
- NonCommercial: the material may not be used for commercial purposes
- ShareAlike: if you remix, transform, or build upon the material, you must distribute your contributions under the same license

The documentation and lexicon scope includes: the four-mode direction-word lexicons (activation_terms), the transfer index (transfer_index), design documents, wiki documents, and technical reports.

### C.3 Commercial and Research Use

- Academic use: academic citation is free; for algorithm reproduction, commercial use, or derivative research, prior consultation with the author is required
- Commercial use (dual-licensing model): commercial use of the core code may either (a) comply with all terms of AGPL-3.0 (including the network-service source-disclosure obligation), or (b) contact the author for a separate commercial license; any commercial use of the lexicons and documentation (CC BY-NC-SA 4.0) requires the author's authorization
- Integrated use: when integrating P1 into a commercial product, the core code portion must comply with AGPL-3.0's network-service source-disclosure requirement

### C.4 License List of External Academic Resources

The external academic resources integrated into the P1 system each retain their original licenses. The 14 integrated resources and their license information are listed below (scope consistent with Table 6-7 of Chapter 6; the authoritative license terms are those on each resource's original release page).

| Resource Name | Data Scale | License | Use in P1 |
|----------|----------|--------|--------------|
| ConceptNet Numberbatch | 294,716 Chinese words + 516,782 English words (300 dims) | CC-BY-SA 4.0 | Word-vector centroid computation, cosine distance, analogical divergence, lateral inhibition |
| SWOW-ZH24 | 10,024 cue words | CC-BY-NC-SA 4.0 | Core engine of associative divergence |
| ConceptNet inverted index (simplified edition) | 256,032 words | CC-BY-SA 4.0 | Causal-attribution divergence and hop2 two-hop expansion |
| NRC-VAD v2 | 54,801 words | Open for academic use | Six-axis scoreWord and polarity detection |
| NRC-Emotion-Lexicon | Emotion lexicon | Open for academic use | 405 transfer_index entries integrated |
| DLUT affective lexicon | 27,467 words | Open for academic use (Dalian University of Technology) | Polarity inference |
| DomainWordsDict | 561,000 words (69 domains) | Open source | Six-axis scoreWord domain localization |
| THUOCL | 11 domains | Open source (Tsinghua University) | Six-axis scoreWord domain-term localization |
| BCC word frequency | 434,000 words | Academic use (Beijing Language and Culture University) | Function-word filtering and domain localization |
| CoreNatureDictionary | 153,000 words | Open source (HanLP) | Function-word filtering |
| ESConv | Emotional-support dialogue corpus | Open for academic use | 128 transfer_index entries integrated |
| affective_zh_11k | 25,044 words | Open for academic use | VAD supplement (Chinese) |
| concreteness_78k | 87,942 words | Open for academic use (Brysbaert) | Six-axis scoreWord concreteness dimension |
| cogmech_gemini.json | 9,134 words | Internally generated | Six-axis scoreWord and polarity detection |

In addition, the P1 resource library contains 44 further high-value external resources not yet wired into the code (including OpenHowNet, ATOMIC2020, FrameNet, the Master Metaphor List, etc.), whose license information can be consulted on each resource's original release page. Users integrating these resources should verify and comply with the corresponding license terms on their own.

### C.5 Disclaimer

The P1 system and its lexicons are intended to provide cognitive direction assistance for dialogue systems and do not constitute professional psychological counseling, medical diagnosis, or treatment advice. P1's direction-word output follows the "Four Redlines" principle (no creation, no scoring, no projection, no influencing the system); all outputs are cognitive direction hints and should not be interpreted as diagnoses or judgments of the user's psychological state.

---

*P1: An LLM-Free Front-Loaded Cognitive Divergent Recall Engine -- Chapters 8-10 and Appendices*
