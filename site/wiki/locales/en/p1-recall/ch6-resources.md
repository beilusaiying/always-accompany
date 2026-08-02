# Chapter 6 Resource System and Appendices

## 6. Introduction

This chapter discusses the external language resource system on which the self-driven Divergence & Recall system depends, the design principles of its self-built lexicon system, and the norms and constraints that support the entire engineering practice. The preceding five chapters respectively addressed the system's philosophy and conceptual framework, process framework, core algorithms, memory system, and evolution history. This chapter focuses on the "material" layer underpinning all of the above — what the system reads, where the words come from, what the admission threshold is, and what engineering discipline has been distilled through long-term iteration.

The chapter's core thesis can be summarized in one sentence: **The system's bottleneck is not the quantity of language resources, but the ability to use existing resources for precise positioning.** This judgment runs through both the resource system and lexicon system sections, and is key to understanding the system's mid-to-late-stage design pivot — which the designer summarized as: the lexicon is already sufficient; what is truly needed is resources capable of positioning. Around this thesis, the chapter proceeds through: the language resource system and how resources are integrated in the system (6.1), the design of the self-built lexicon system (6.2), and engineering norms and constraints (6.3). Two appendices follow — a glossary (Appendix A) and the system's current status and roadmap (Appendix B) — concluded by a summary (6.4).

It should be noted that this system's self-built lexicon assets (the data bodies of the activation term layer and the adapter inverted layer) are non-public term-generation assets. This chapter describes only their structure, scale magnitude, and integration points in the system, without disclosing term content or mapping details. Where precise scale numbers are involved, they are obfuscated according to publication classification.

---

## 6.1 Language Resource System

### 6.1.1 The Cognitive Pivot: "Resources Are Not Lacking; Positioning Is"

This system underwent a significant course adjustment in the mid-to-late period. The early optimization path was to continually expand the lexicon — continuously introducing more association words, domain words, and clinical words to improve divergence coverage. The designer subsequently and explicitly rejected this path, redirecting the optimization focus from "word quantity" to "positioning" — that is, the ability to activate the correct cognitive direction. The basis for this pivot was a series of observations: association divergence itself performed well and did not deviate from direction; deviation occurred in the transition from association results to professional direction words. In other words, the problem was not that there were insufficient words for divergence, but that the transition and positioning mechanisms failed to apply the abundant existing resources to the correct direction. The designer attributed the catch-all phenomenon (see glossary) to "unstable positioning due to insufficient axes and information," rather than toxic lexicons.

This judgment is supported by a quantitative resource utilization audit. The system's local resource library totals tens of gigabytes (approximately 55 to 61+ GB), while only a dozen or so core resources are actually integrated into the running pipeline (14 core resources, plus 3 that are "loaded but not actually used"). By this calculation, the actual utilization rate of the resource library is less than one percent (approximately 0.46%). This audit result constitutes direct evidence for the cognitive pivot described above: what constrains system performance is not insufficient data reserves, but the positioning algorithm's failure to connect existing resources into the pipeline. Continuous lexicon expansion was accordingly determined to be a falsified optimization direction (related rejected experiments are discussed in Section 6.3).

### 6.1.2 Integrated Resources and Their Integration Points

Of the tens of gigabytes in the resource library, 14 core resources are currently integrated into the pipeline and consumed. "Integration point" refers to where in the Divergence & Recall pipeline a resource is read and used. Table 6-1 lists these 14 resources, their data scales, and integration points.

**Table 6-1: Integrated Resources and Integration Points**

| No. | Resource | Data scale | Integration point (consumption point) |
|------|------|----------|--------------------|
| 1 | Cognitive mechanism lexicon | 9,134 words | Six-axis scoring + polarity detection |
| 2 | NRC-VAD emotional valence lexicon (v2) | 54,801 words | Six-axis scoring + polarity detection |
| 3 | Chinese sentiment lexicon | 25,044 words | Valence dimension supplement (Chinese) |
| 4 | Concreteness lexicon | 87,942 words | Six-axis scoring (concreteness) |
| 5 | 300-dimensional word vectors (Chinese) | 294,716 words | Centroid + cosine distance + analogy + lateral inhibition |
| 6 | SWOW Chinese association data | 10,024 stimulus words | Association divergence (core) |
| 7 | ConceptNet inverted index (simplified) | 256,032 words | Attribution divergence + two-hop diffusion |
| 8 | Activation term layer (self-built) | 538 dimensions / 4,522 terms | All stages (core self-built asset) |
| 9 | Adapter inverted layer (self-built) | 26,715 trigger items | Adapter lookup (core self-built asset) |
| 10 | Domain dictionary | 561,000 words (69 domains) | Six-axis scoring (domain positioning) |
| 11 | Domain classification lexicon | 11 domains | Six-axis scoring (domain words) |
| 12 | Large-scale corpus word frequency table | 434,000 words (news/literary/conversational) | Function-word filtering + domain positioning |
| 13 | Sentiment dictionary | 27,467 words | Polarity inference |
| 14 | Core POS dictionary | 153,000 words | Function-word filtering (POS cross-validation) |

Beyond these 14 items, a batch of "loaded but partially or completely unused" resources also exists in the system. These resources have been read into memory but are not actually called by the six-axis scoring or adapter scoring algorithms, constituting a concrete facet of the utilization shortfall: multi-dimensional semantic annotation lexicons (such as psycholinguistic rating resources across several dimensions) are loaded but unused in scoring; an emotion annotation dictionary is loaded but its emotion classification is not used for scoring; a frame semantics resource is loaded but unused for divergence; a causal relation index is loaded but has zero invocations (dead code); a suppression list of high-frequency generic terms is also loaded but has zero invocations. These phenomena collectively corroborate an engineering lesson: **The presence of a resource-loading statement in code does not mean the resource actually takes effect at runtime.** Therefore, when describing system capabilities, verification must be based on actual running code, distinguishing between "resource available" and "functionality deployed."

### 6.1.3 Resource Category Overview and Scale

If integrated, available-but-not-integrated, and planned-for-integration resources are all catalogued together, the system's accessible language resources can be categorized into several types. By the "integrated / available but not integrated" calibration, the total resource landscape is approximately 57 items (13 in use + 3 loaded but unused + 44 not integrated). Table 6-2 summarizes by category, listing representative not-yet-integrated resources and their scales to illustrate the distribution of expansion potential.

**Table 6-2: Resource Category Overview**

| Category | Integrated | Available but not integrated | Representative not-yet-integrated resources (scale) |
|------|--------|--------------|--------------------------|
| Positioning / graphs | 3 | 8 | Sememe knowledge base (~2,000 sememes × 100,000 words) / complete concept graph (34 relation types, million-level triples) / causal knowledge base (900,000 causal pairs) / hierarchical synonym thesaurus (77,000 words) / frame semantics network (1,222 frames) / lexical network (117,000) etc. |
| Emotion / psychology | 5 | 11 | 7-category emotion lexicon / 27-category fine-grained emotion lexicon / emotion annotation dictionary (14,000 words × 8 emotions) / emotional support strategy library / cognitive distortion library / entity-emotion database (300,000) etc. |
| Synonym / antonym | 0 | 4 | Chinese synonym database (52,000 pairs) / near-synonym and antonym database (17,000 synonyms + 19,000 antonyms + negation) etc. |
| Cognitive / logical | 0 | 3 | Cognitive bias library (194 entries) / mental model library (119 models / 40 domains) / concept-law library (80+ entries) |
| Narrative / ACG | 0 | 6 | Narrative trope library (30,000 tropes) / ACG Chinese lexicon / narrative terminology library / subtitle and light novel corpora etc. |
| Programming | 0 | 2 | Programming terminology library / code smell library |
| Multi-dimensional annotation | 3 (loaded, unused) | 3 | Multi-dimensional psycholinguistic rating lexicons (several dimensions, thousands to tens of thousands of words) |
| Stopwords / frequency | 2 | 2 | Multiple stopword lists / per-domain word frequencies |
| Computational tool libraries | 0 | 5 | Approximate nearest neighbor library / graph community detection library / personalized random walk library / statistical computation library etc. |
| **Total** | **13 in use + 3 loaded but unused** | **44** | **57** |

To intuitively illustrate the thesis that "resources are not lacking," the system once conducted an empirical demonstration on a single word: taking an ordinary adjective as an example, the resource library could simultaneously provide its sentiment classification, intensity, polarity, multi-dimensional emotion distribution, grouped antonyms, synonym group with hierarchical encoding, multi-dimensional semantic coordinates, causal relations, association words with their weights, concreteness, and per-domain word frequencies — over ten types of information. The conclusion of this demonstration is that, in terms of the linguistic information obtainable for a single word, resources are "far from insufficient," thereby counter-evidencing that the system's shortcoming lies in positioning, not word quantity.

### 6.1.4 Correspondence Between Disciplinary Axes and Resources

The system's divergence is built upon six disciplinary axes (psychology, information science, sociology, logic, linguistics, cognitive science; see "six axes" in the glossary). An explicit requirement from the designer is: each disciplinary axis should have corresponding resources for positioning and refinement — that is, each of the six axes is multi-dimensional with corresponding resources, further positioned through spatial coordinate refinement and word-vector distance computation. Table 6-3 gives the correspondence between each axis, its primary resources, and their uses; items marked "planned" are resources not yet integrated.

**Table 6-3: Disciplinary Axis and Resource Correspondence**

| Disciplinary axis | Primary resources (integrated / planned) | Use |
|--------|---------------------------|------|
| Psychology | Cognitive mechanisms, emotional valence, sentiment dictionary (integrated) · Cognitive distortion, emotional support, fine-grained emotion library (planned) | Emotion polarity + cognitive distortion + emotional support directions |
| Information science | Tool-type items from cognitive mechanisms (integrated) · Programming terminology, code smells (planned) | Technical positioning |
| Sociology | Domain dictionary, corpus word frequency (integrated) · Entity-emotion database (planned) | Domain entities + social relationship positioning |
| Logic | Cognitive biases, mental models, predicate-argument structure (planned) | Cognitive bias + causal structure |
| Linguistics | Core POS (integrated) · Narrative tropes, narrative terminology, frame semantics (planned) | Narrative technique + semantic frames |
| Cognitive science | Sensorimotor annotation, multi-dimensional semantics, sememe library (planned; many are "loaded but unused") | Embodied / conceptual space positioning |

As the table shows, resources corresponding to cognitive science, logic, and other axes are mostly in planned or "loaded but unused" status. This is precisely the main gap in the utilization shortfall described in Section 6.1.1. Therefore, when describing the system, one must strictly distinguish: these resources represent "resource availability," not "deployed functionality."

### 6.1.5 Priority Ranking of Available Resources

Among the not-yet-integrated resources, the system once conducted a priority ranking for a batch of locally deployable resources requiring no external API calls (approximately 42 items) to guide subsequent integration. This ranking itself is a direct response to the question "why not use so many resources" — the bottleneck is the positioning work needed to integrate these resources into the pipeline, not data availability. The ranking is roughly divided into three tiers.

**Immediate integration (solving current core problems)**: Approximate nearest neighbor search library (replacing brute-force traversal in six-axis space with approximate retrieval); graph community detection and personalized random walk libraries (replacing per-word lookup adapter approach with random walks); sememe knowledge base (sememe decomposition can directly map to the six disciplinary axes); cross-domain metaphor mapping rule library (providing a "highway" for cross-domain mappings in analogical divergence); large-scale Chinese association dataset (multi-fold coverage expansion of existing association resources).

**Mid-term integration (quality improvement)**: Divergence quantification tools, direction-word combination optimization methods, scene template divergence resources, fine-grained psychological classification libraries, statistical decay and distributional dispersion tools, etc.

**Association dataset expansion**: Multiple larger or differently sourced association word-pair datasets for extending the core association resource's coverage.

**Evaluation and testing resources**: Multiple standard test sets for evaluating divergent association, analogy, remote association, and other capabilities.

---

## 6.2 Lexicon System

The system's self-built lexicon is its core asset distinguishing it from general language resources. This section describes its structure, tiered routing, admission standards, information-word intermediate layer design, content red lines, and physical layering. Again: the lexicon data body is not public; this section discloses only its structure, scale magnitude, and admission methodology.

### 6.2.1 Dual-Layer Structure: Activation Term Layer and Adapter Inverted Layer

The self-built lexicon consists of two paired layers. The **activation term layer** is organized as "dimension → term → attributes": each dimension (e.g., a psychotherapy direction) contains several terms (e.g., a specific cognitive method), each term carrying a prior probability, several colloquial trigger words, and multi-dimensional scores. The **adapter inverted layer** is an inverted index keyed by user colloquial expressions: given a segment of user colloquial speech, the corresponding terms, dimensions, scores, and sources can be looked up.

A hard constraint exists between the two layers: modifying the activation term layer requires synchronous modification of the adapter inverted layer; otherwise the lookup pipeline breaks. Additionally, the adapter inverted layer's value structure must be an array, not an object — this constraint stems from repeated lessons: using an object format caused keys to be parsed as numeric indices during traversal, resulting in the corresponding suppression mechanism never taking effect. At runtime, the main activation term layer is further merged with several supplementary resources to form a larger combined lexicon (on the order of several hundred dimensions and several thousand terms).

It should be noted that some field names in the activation term layer are technical design choices at the implementation level and may not correspond to the designer's original formulation. The designer's confirmed external output is the structured markup of direction words, not these internal fields. Therefore, when referencing lexicon structure, internal fields should be distinguished from design intent.

### 6.2.2 Large-Medium-Small Three-Level Routing

Lexicon routing adopts a coarse-to-fine three-level structure. The designer used a book analogy to explain: large corresponds to the general direction, medium corresponds to a local part of the direction (can be overlaid), and small corresponds to the term pool and specific terms within it. Table 6-4 gives the meaning and analogy for each level.

**Table 6-4: Large-Medium-Small Three-Level Routing**

| Level | Meaning | Book analogy |
|------|------|----------|
| Large | General direction (discipline / major category) | Chapter |
| Medium | Local part of the direction (can be overlaid) | Section |
| Small | Term pool → specific terms | Entry |

A key property of three-level routing is: the middle level (local part of the direction) can be overlaid — that is, multiple medium categories can be hit simultaneously and combined. This "medium-category overlay" is currently partially implemented. The design philosophy behind three-level routing is: direction words are "table of contents / book title" level entry points, not the content itself; once the primary model receives a direction word, it automatically invokes the entire knowledge framework corresponding to that direction. In other words, direction words are seeds pointing to knowledge trees, not knowledge itself.

### 6.2.3 Direction Word Admission Standards

Direction words must simultaneously satisfy six admission standards to be admitted:

1. **Searchable** — can be found on a public search engine, encyclopedia, or academic page;
2. **Consensus-backed** — recognized by practitioners in the domain, not self-coined;
3. **Is a direction word** — points to a cognitive, therapeutic, or analytical direction;
4. **Not a diagnostic word** — for therapeutic or preventive direction, not a diagnostic label;
5. **Not a route word** — for direction, not a specific action instruction;
6. **Not colloquial** — a professional term, not an everyday description.

It must be emphasized that admission does not require academic citations, wiki entries, or author attribution — the standard is "searchable and consensus-backed," not academic rigor per se.

The core test for admission can be summarized in the designer's own judgment (designer's original words): "A word that the primary model could derive from bare reading of the original text is a dead word; the value of P1 lies in giving the primary model directions it cannot think of on its own." Accordingly, the essence of direction words is "searchable professional terminology seeds that open knowledge entry points the primary model cannot open on its own." Using a daily help-seeking scenario as an example: common-sense concepts the primary model can think of on its own are dead words, while professional directions the primary model would not easily think of on its own (such as the professional name for a behavioral pattern, or a type of cognitive distortion) are valuable direction words.

In admission practice, the system further distinguishes three types of words: genuine terms (retained); pseudo-terms assembled from genuine terms (deleted — characterized by genuine terms suffixed with generic suffixes); and instructional labels (which should be placed in system prompts rather than the lexicon).

### 6.2.4 Information Word Intermediate Layer and Three-Layer Pipeline Architecture

Above the direction word layer, the system designed the "information word" as an intermediate aggregation layer. The motivation came from an architectural correction. The early pipeline was: user colloquial speech was directly mapped to direction words via adapter inverted lookup. Because of the large semantic distance between colloquial speech and professional direction words, precision was low. The corrected pipeline introduces information words as an intermediate layer: user colloquial speech first maps via adapter inverted lookup to information words (which lack output eligibility), then information words map via bridging to direction words (which have output eligibility), and finally output. The role of information words is aggregation — multiple different colloquial expressions first converge to one information word, which then precisely bridges to direction words, achieving "many-to-one" convergence. This replaces the previous pattern of "one information word pointing to multiple loosely related direction words." The designer pointed out that the previous divergence had one information word pointing to multiple direction words with low relevance and no relevance penalty; the corrected direction should be multiple information words corresponding to one direction word. The significance of information words is to provide more useful possibilities for direction words.

This architectural effort produced a batch of new information words and adapter items, and brought bridging coverage to completeness. All information words are marked as non-output-eligible and carry bridging fields. Taking two pipeline examples: in a chat scenario, multiple expressions of fatigue converge to a "daily fatigue" type information word, which then bridges to several specific psychological direction words; in a coding scenario, multiple expressions of error reports converge to an "error feedback" type information word, which then bridges to several specific diagnostic direction words.

### 6.2.5 Lexicon Content Red Lines

As a self-built asset, the lexicon must satisfy a set of content red lines. Direction words must never carry: no sexual orientation labels or terms; no graphic violence; no death-type words (no inducement, no applying death-type labels); no malicious speculation (no projecting user state, no conjecturing negative psychological states of the user).

These content red lines share the same source as the system's "no projection" output boundary (see Section 6.3): direction words are suggestions for the primary model, not judgments about the user. Any speculation about or labeling of the user's negative state is vetoed outright. In lexicon maintenance practice, this red line has been used to clear several contaminated entries (such as entries with political overtones or constructed by character-splicing), demonstrating the content red line's enforcement in actual maintenance.

### 6.2.6 Physical Layering and Self-Learning Pipeline

The lexicon is physically divided into three layers:

- **Core layer**: The core direction word lexicon, admitted through manual review (satisfying the six admission standards and content red lines). This is the most stable layer.
- **Plugin layer**: Hot-swappable lexicon packages that can be dynamically plugged and unplugged by mode or domain (such as narrative, programming, psychology). A common misconception must be clarified: swappable domain lexicons are a design intent, not a defect — they embody the "hot-swap" design orientation.
- **Learned layer**: The lexicon layer produced by the self-learning pipeline, entering after annotation and gating.

Regarding the self-learning pipeline ("typing-style self-learning" term-generation pipeline), its design intent is for the system to automatically generate terms, which then enter the lexicon through annotation, gating, and hot-swapping. This pipeline is currently not enabled: its word-frequency accumulation function has zero invocations (dependent on an annotation pipeline not yet integrated), and the self-learning switch is hardcoded to off. A prior incident where this function contaminated a real user word list was remediated, and it has been listed as a testing constraint (see Section 6.3). The coupling between the term-generation pipeline and the main divergence pipeline is through a single interface — the activation term layer: the term-generation pipeline writes; the divergence pipeline reads. The direction is unidirectional, with no mutual interference.

The lack of automatic gating for lexicon admission is one of two upstream root causes during a certain phase of the system: each time the library was expanded with a new batch of raw association words or clinical words, the system had no accumulated memory of "what words are effective." The fundamental solution is to establish a self-upgrading term-generation closed loop.

### 6.2.7 Four-Layer Linkage Path from Baseline to Target

In terms of overall lexicon optimization benefit, the system summarized a linkage path spanning lexicon, code, prompts, and annotation models. The true scoring baseline must be determined with caution: coarse evaluation methods yield inflated scores and cannot be used as a decision basis. A gap exists between small-sample manual evaluation and large-sample strict evaluation, with the large-sample result (several hundred real cases, multi-dimensional strict scoring) being the most trustworthy and usable as a baseline.

From this baseline, the system analyzed several stackable improvements and their approximate benefit magnitudes (all benefits below are analytical estimates, not precisely fixed): adding a direction-signal consumption step in the prompt's chain of thought yields the highest benefit with the best return on investment; outputting structured direction markups in code yields the next-highest benefit; lexicon term-name alignment and quality repair, annotation model training, and large-sample optimization loops each contribute decreasing increments. The four-layer linkage is indispensable in its entirety, with a theoretical ceiling of approximately seventy percent of the maximum score.

The most critical finding in this analysis is: **the largest root cause is the breakage of the prompt consumption pipeline** — if direction words are not consumed by the prompt, they become information islands. Accordingly, the single change with the highest return on investment is adding one line referencing the direction signal in the prompt. The designer's conclusion on this: the effect of one line of prompt may exceed the sum of dozens of code changes and extensive admission work combined. However, it must be pointed out: **the prompt consumption pipeline belongs to the primary model prompt's domain of responsibility, which the designer has explicitly declared outside this system's jurisdiction — touching it is prohibited.** Therefore, this path is an analysis of "how much benefit could be achieved if done," not a to-do item for this system.

Regarding the annotation model's integration status, the system uses a locally deployed small-scale model (not an external API call). Without an annotation model, the baseline is relatively low; training and prompts alone can yield approximately a twenty percent improvement; adding code changes can yield approximately a forty percent improvement; the ceiling is limited (because annotation voting accounts for only approximately one-quarter weight in the overall system). Currently, full multi-head annotation has not been implemented, and annotation model invocations number zero.

Regarding the current scale of the lexicon, the system's four modes (chat, narrative, coding, work) combined total in the order of ten thousand terms, of which direction words account for approximately thirty percent and information words approximately seventy percent. Precise numbers fluctuate slightly between snapshots; only order-of-magnitude descriptions are given here. The precise scale is a self-built asset; external descriptions are obfuscated to "ten-thousand-level terms, direction words approximately thirty percent."

---

## 6.3 Engineering Norms and Constraints

This system has distilled a set of engineering norms and constraints through long-term iteration. These norms are not abstract slogans but executable disciplines extracted from real failures and rollbacks, aimed at providing hard guarantees for the system's correctness and reproducibility. This section organizes them into several groups. The overarching meta-principle is the designer's stance on numerical values: the designer discusses only algorithms, not any specific data. Therefore, all numerical values appearing in the system are by default "experimentally calibrated fixed values" or "initial default values (not systematically tuned)," and must be constrained and eliminated through experimentation.

### 6.3.1 Absolute Boundaries of Output and Algorithm

The first group of constraints defines the absolute boundaries of output and algorithm: do not use the divergence engine as a text continuation engine; do not simplify algorithms (multi-head, normalization, and other structures must be fully preserved), and keep response time within acceptable bounds; do not treat recalling real-world memories in role-play scenarios as a defect (this is the design of cross-scenario profile continuity); do not use keyword overlap as the ground truth for evaluation (ground truth must come from genuine manual annotation or structured matching); do not set the designer's personal preferences as system defaults (default weights use equal values); synonym and antonym diffusion must not enter the divergence end (synonyms and antonyms are used only at the scoring end; diffusion-end expansion distance is kept large, as empirical testing shows the reverse causes degradation); do not hardcode a small number of regex words to trigger escalation (must use semantic categories, otherwise coverage breadth is insufficient); do not modify the signatures and return fields of core interfaces; do not read large resource files in their entirety (must read in streaming fashion); do not use random numbers as test seeds (must run multiple times and take averages; no conclusions from a single run).

These ten rules can be summarized as a mnemonic: no continuation, no simplification, not a defect, no overlap, no default contamination, no close-distance diffusion, no hardcoded regex, no signature changes, no full-read of large files, no single-run conclusions.

### 6.3.2 Core Engineering Iron Rules

The second group comprises core engineering iron rules distilled from extensive design conventions: before modifying a scoring formula, the actual value-range distribution (extremes and percentiles) must first be output — otherwise roll back; real data must be used for verification rather than only running fixed small samples, with mean and variance from multiple runs provided; actual structured output must be examined, not just scores; give directions rather than routes, with user-experience-oriented words prioritized over obscure terminology; maintain a commitment to zero-cost local-first operation; mechanism parallelism is not axis parallelism (each mechanism independently produces divergence words carrying a mechanism label); contract first then diverge (the retrospection mechanism does not require complex judgment); output must be direction words capable of carrying knowledge, not isolated nouns; adopt large-medium-small three-level routing with overlayable medium categories; completion can be claimed only when results are stable and only one change is made at a time (a "fix" not verified across multiple runs cannot be claimed as complete).

Above these specific iron rules are three meta-level constraints: stable structural constraints are superior to stacking rules (one cannot require the executor to have judgment, but can ensure it has no room to cheat); consult design documentation first when encountering problems; use beating the baseline as the yardstick rather than sweeping grand objectives.

### 6.3.3 Soft Isolation Rather Than Hard Filtering

The system's filtering philosophy has one core principle: **Hard filtering is strictly prohibited; soft isolation is mandatory.** Cross-mode differentiation must be achieved exclusively through soft mechanisms, never hard exclusion.

The difference between soft isolation and hard filtering is: under soft isolation, words do not vanish but are merely down-weighted or down-ranked, so that boundary words are not hard-deleted and cross-mode recall opportunities are preserved; under hard filtering, words are directly skipped and lose recall opportunity, severing cross-mode information flow — this is the prohibited form. In implementation, what is prohibited includes direct skipping, blacklist-hit skipping, and per-mode hard filtering; what is required includes multiplicative soft weights for down-weighting or up-weighting, routing weighting, axis decay coefficients, and similar soft isolation mechanisms. The system has historically implemented multiple soft filtering mechanisms, including large-medium-small routing soft weights, mode soft weights, axis soft decay, dynamic soft range, catch-all soft down-weighting, suppression soft down-weighting, primary-secondary proportions (primary-secondary without deletion), mode-correlated soft scores, and axis exponential decay.

A critical lesson: **multi-layer penalties chain-multiplied are equivalent to hard deletion, equally in violation.** When multiple penalty coefficients are multiplied layer by layer, their product can become small enough to effectively delete the word. Therefore, one should take the minimum of multiple penalties rather than multiplying them layer by layer. Related rejected experiments include hard mode switching and hard lexicon merging, both of which caused across-the-board degradation and were reverted.

Another recurrent root cause: **upstream contamination cannot be rescued by downstream soft filtering.** If contamination words enter during the upstream coordinate accumulation stage of the pipeline and proceed through the association diffusion end directly into output — bypassing the voting path — then downstream soft weights are ineffective against these already-entered high-frequency words. The lesson: soft filtering should be placed at the contamination entry point, not the exit; root-cause repair (improving lexicon precision) is superior to exit-side hard blocking. The designer's further requirements for soft isolation: primary-secondary proportions without hard deletion, boundary words without hard deletion, no blacklist stacking, and soft isolation that does not depend on fixed numbers — the primary direction occupies roughly sixty percent, with other directions determined situationally.

### 6.3.4 Numerical Values, Spatial Perspective, and Output Red Lines

The fourth group of norms defines the system's stance on numerical values, spatial perspective, and output red lines.

On numerical values, the system's meta-position is: wherever numbers appear, they are values awaiting constraint, and the designer discusses only algorithms. From this it follows that all thresholds and weights in this system are by default experimentally calibrated or initial default values. The governance method for such values is to constrain and eliminate them through experimentation, or to replace manually adjusted values with authoritative algorithms and resources — not "make up numbers when no algorithm is found."

On spatial perspective, the system maintains the position of "spatial additive rather than linear multiplicative, not hard matching": information aggregates into a pool, converges toward the proximate direction, and undergoes distributional voting. The core antithesis is multiplication (multiplication should be replaced by averaging).

On the relationship between the six axes and the output-end positioning coordinates, the system explicitly states that they are not the same thing: the six axes are input-end independently parallel disciplinary mechanisms; the output-end positioning coordinates are spatial positioning based on divergence results. The two are not in a parent-child relationship.

On output red lines, the system sets four absolute boundaries for divergence output: no creation, no scoring, no projection, no system influence. Among these, creation, scoring, and system influence are red lines for the primary model; projection is a shared red line for both the divergence layer and the primary model (the divergence layer does not label users). Compliant creativity (cross-disciplinary analogy, new plot triggering, episode creation) comes from the primary model. The annotation model in the system performs only limited annotation tasks (such as error correction, conversation segmentation, independence judgment, direction annotation, character annotation) and produces absolutely no creative content.

### 6.3.5 Backup and Isolation Constraints

The final group comprises operational-level hard constraints: before major changes, deletions, or additions, a full physical backup must first be made on an independent disk — version control stash mechanisms must not be used as a substitute, nor should the system cache disk be occupied. Divergence output enters only the designated output markup; divergence does not connect to the memory body (isolation red line). Deletion only deletes — no additions may be bundled (pure deletion constraint). White-box observation must remain always on, with every node instrumentable. Testing must be conducted in an isolated environment; when probes pass real user context, the self-learning switch must be off (contamination of real user word lists has occurred); sandbox environments must not restart production environments; scripts containing regex must be generated via file-write to avoid escaping issues.

---

## Appendix A: Glossary

This glossary collects core terms used in this chapter and throughout the book, for reference by external readers with no prior background. Each entry provides the term, its definition, and the chapter of first appearance. All definitions are normative statements; internal implementation-level names are noted within the definitions.

**Table A-1: Glossary**

| Term | Definition | First appearance |
|------|------|----------|
| Self-driven Divergence & Recall (P1) | A divergence node externally and mandatorily inserted by the primary model, responsible for memory recall and content divergence, producing direction words for injection into the primary model's prompt. Its characteristics are zero external call cost, local execution, low latency, and white-box observability. | Chapter 1 |
| Three-stage mechanism | The processing paradigm of Divergence & Recall, proceeding as contraction, divergence, contraction: first extract context-relevant entries (contraction), then perform anchor-based divergence from the context (divergence), then distill results into meaningful professional content (contraction). The third stage still performs contraction. | Chapter 1 |
| SWOW (association data) | A large-scale word association dataset serving as the physical source and core divergence engine of the system's association divergence. | Chapter 3 |
| Adapter | The entirety of all processing after association divergence; its essence is recall: using divergence-derived words to recall supportable content. | Chapter 3 |
| BLQ | The system's scoring framework, contained within the adapter, used in two places: information word filtering and direction word filtering. It currently primarily performs multi-factor ranking and is still being optimized. BLQ is part of the adapter, not the divergence engine itself. | Chapter 3 |
| Information word | An intermediate aggregation word at the surface layer, lacking output eligibility, bridging to direction words. Multiple colloquial expressions converge to one information word (many-to-one); its role is to provide more useful possibilities for direction words. | Chapter 6 |
| Direction word | An output word at the line layer, possessing output eligibility, injected into structured output markup. It is a suggestion for the primary model, not a judgment about the user — a searchable professional terminology seed. | Chapter 6 |
| Dead word | A word that the primary model could derive from bare reading of the original text alone, with zero information gain. The system's value lies in providing directions the primary model cannot think of on its own. | Chapter 6 |
| Catch-all term (phenomenon) | A high-frequency generic term appearing in the vast majority of inputs. Its fundamental cause is unstable positioning and insufficient information, not the word itself being toxic; the solution is to improve positioning, not to stack penalties. | Chapter 3 |
| Six axes | Six independently parallel disciplinary mechanisms at the input end (psychology, information science, sociology, logic, linguistics, cognitive science); each axis is multi-dimensional, each outputting a set of words rather than a single coarse property. | Chapter 3 |
| Output-end positioning coordinates (47 axes) | Detailed spatial positioning coordinates at the output end, based on divergence results for positioning and range constraint; they do not perform scoring themselves. Not in a parent-child relationship with the six axes. | Chapter 3 |
| QKV | The annotation layer performed by the annotation model (not in the lexicon), used to activate perception and driving axes but not participating in axis output: representing the user's appeal, topic keywords, and emotional tone respectively. QKV is not an axis. | Chapter 4 |
| Spatial additive (voting) | The system's core computational perspective: information aggregates into a pool, converging toward the proximate direction and performing distributional voting, rather than per-word multiplication or hard matching. Multiplication should be replaced by averaging. | Chapter 3 |
| Temperature | The calibration mechanism for divergence range: diffusing outward in a circle, neither too close nor too far, requiring filtering. Its modern counterpart is a calibrator that converts incomparable raw scores into comparable probabilities, not an ordinary hyperparameter. | Chapter 3 |
| High-volume near-miss (recall) | A recall strategy: preferring to over-recall near-miss content as long as the direction aligns with the conversation; the recall end does not pursue precision but pursues coverage and directional alignment. | Chapter 4 |
| Point-line-surface-volume | A set of hierarchical concepts: point is vocabulary, line is direction (the kind of vocabulary), surface is type (the actual need of the user's conversation), volume is multi-dimensional space. Processing order is top-down: volume → surface → point → line. | Chapter 1 |
| Proximity | The degree to which pooled data gravitates toward a particular axis; the primary direction is determined accordingly, then divergence extends to other axes with axis decay applied. | Chapter 3 |
| Hot-swap (lexicon) | Plugin-layer lexicons dynamically pluggable and unpluggable by mode or domain. Swappable domain lexicons are a design intent, not a defect. | Chapter 6 |
| White-box | The system's observability requirement: observation must be always on, and every node must be instrumentable. Corresponds to the "single-breakpoint inspection of real data flow" verification principle. | Chapter 2 |
| Soft filtering | A filtering method where words do not vanish but are merely down-weighted or down-ranked (as opposed to hard filtering's direct skipping). Multi-layer chain multiplication equivalent to hard deletion is equally in violation. | Chapter 6 |
| Output eligibility | The output eligibility mark of an activation term: those with eligibility are direction words (can enter output); those without are information words (serve only as bridging intermediate layer). Default pass-through of eligibility was once a primary source of catch-all terms. | Chapter 6 |
| Mechanism parallelism | Each mode selects its most relevant mechanisms to run in parallel; non-participating mechanisms are completely silent. Mechanism parallelism is not axis parallelism, nor is it weight adjustment. The six independent mechanisms are: scenario, embodied, metaphor, narrative, opposition, and analogy. | Chapter 2 |
| Dimension broadcast | The phenomenon where all terms within the same dimension receive the same voting score without distinguishing semantic match quality — the true root cause of catch-all terms, not an inverted-index data problem. (This is an implementation-level naming.) | Chapter 3 |
| Just-right distance | Filtering of divergence distance: too close (synonym redundancy) and too far (random noise) are both down-weighted, preserving the middle band. Corresponds to the temperature circle's orientation of "neither too close nor too far." | Chapter 3 |
| Six degrees of separation (six-degree distribution) | The theoretical fulcrum of divergence: no matter how unrelated two things are, they are connected within a few steps; cross-framework analogy is precisely this kind of multi-step distribution. | Chapter 3 |
| Activation term layer | A layer of the self-built lexicon, organized as "dimension → term → attributes," with each term carrying a prior probability, colloquial trigger words, and multi-dimensional scores. (Core self-built asset; data body not public.) | Chapter 6 |
| Adapter inverted layer | A layer of the self-built lexicon, an inverted index keyed by user colloquial expressions, paired with the activation term layer. Must be modified synchronously; value structure must be an array. (Core self-built asset; data body not public.) | Chapter 6 |
| Component state and live state | Two existence forms of the system: component state means algorithm components are fully implemented but not reconnected to the main pipeline; live state means actually integrated into production and running. The algorithms described in this text are implemented, awaiting-reconnection component-state modules. | Chapter 2 |

---

## Appendix B: System Current Status and Roadmap

This appendix describes the system's current implementation status and subsequent roadmap. This is the part that most requires accuracy in external communication and must not be overstated.

### B.1 Component State and Live State

The system's complete recall and divergence pipeline has been fully implemented and closed in the pipeline, qualifying as component-state complete. However, two main pipelines have not yet been reconnected to production: the self-driven divergence pipeline was removed by instruction, and the current production environment runs only the preset-retrieval-based divergence line; the memory native recall was removed in the same batch, and the current production memory injection is the preset-retrieval line. The designer's characterization: divergence and recall had become nearly complete in the later period; the so-called crashes stemmed from code execution issues, not the design itself. Accordingly, the accurate external wording should be: "Core algorithms are complete and have passed full-volume experimental closure; currently undergoing fine-tuning and main-pipeline integration."

### B.2 Pending Items

The system currently has "all self-drivable items completed," with several items remaining that require the project lead's decision: timing of main-pipeline reconnection (irreversible; sandbox verification required before production reconnection); whether data recall should be switched to default-on (currently gray-scale off; experiments show most cases have produced data anchors and output has changed; inclination is to evaluate as part of full-pipeline verification); attribution of directional skew in one mode (synonym merging cannot solve structural skew; the fundamental solution lies in cross-window term-generation supplementation; whether to initiate a project is pending); whether a particular backup knob should be promoted (default: do not promote; modest reduction accompanied by word drift and increased computational cost).

The next-step value ranking is: main-pipeline reconnection (ready; awaiting evaluation); work-mode lexicon reinforcement (current largest gap; methodology reusable; self-drivable); AIRP mode out-of-character protection (mechanism-type; requires design decision); directional skew reorganization (requires cross-window term generation).

### B.3 Design Vision Versus Deployment Status

When describing "what has been implemented," one must strictly distinguish design vision from deployed functionality — visions must not be written as deployed. Table B-1 provides a deployment-status comparison for several key design points.

**Table B-1: Design Vision and Deployment Status**

| Design vision | Deployment status | Notes |
|----------|----------|------|
| Along-direction re-divergence (core innovation) | Partially deployed | Early implementation was "recall-weighted" rather than "diverge along direction"; later, the secondary divergence portion was deployed (multi-path diffusion); regionalized divergence along cognitive directions is still incomplete |
| Volume → surface → point → line processing order | Partially deployed | Early implementation skipped the "surface" layer (user's actual need type); later, six-axis surface emission deployed part of the "surface" layer |
| Mode as mechanism combination (not weight adjustment) | Not deployed | Still "all-axis scoring + per-mode weight adjustment"; mechanism parallelism was subsumed into sorting, three-layer, and axis implementation details |
| Multi-head annotation | Not integrated | Zero annotation model invocations; only simple scalar classification; this is the annotation layer gap in the four-layer linkage path |
| Coordinate accumulation upgraded to region representation | Not done | Coordinate accumulation is still a flat vector; each word is still a point, with no region, variance, or metric tensor |
| Concept graph inverted index fully built | Not fully built | Only the causal subset is loaded; once fully built, subsequent engineering effort can be significantly reduced |
| Analogy's cross-domain structural mapping | Partially deployed | Only semantic neighborhood diffusion; lacking cross-domain structural isomorphism; analogy sorting has been promoted but remains at the linear analogy level |

The system also has a batch of mechanisms empirically promoted in the later period (such as analogy sorting, distance gating, meta-discourse channel), as well as several that were judged negative, had broken links repaired, or were observed and closed.

### B.4 Four-Mode Effectiveness

In an evaluation of several hundred real cases (balanced sampling across four modes), the system's four modes performed as follows: chat and coding modes performed well; AIRP mode was medium (genuine role-play was fitting; meta-conversation had noise); work mode was weakest (excessive organizational behavior words; cannot handle technical input). A common issue across all four modes is that each has a few persistently appearing "tail words." Table B-2 gives the rating and performance overview for each mode.

**Table B-2: Four-Mode Effectiveness**

| Mode | Rating | Performance | Persistent tail |
|------|------|------|----------|
| Chat | Good | Accurate positioning for emotional input | A few relationship-type words persistently appear |
| Coding | Good | Technical input hits the mark | A few network-error-type words persistently appear |
| AIRP | Medium | Genuine role-play is fitting | Romance narrative words forced on meta-conversation |
| Work | Weak | Cannot handle technical input; organizational behavior word drift | A few organizational behavior words persistently appear |

Accordingly, the two reinforcement directions (neither altering already-promoted mechanisms) are: work-mode lexicon reinforcement (largest gap; methodology reusable; self-drivable); AIRP mode out-of-character protection (mechanism-type; requires design decision).

### B.5 Primary Crash Pathology

A single sentence summarizes the key to understanding this system's history: **The primary crash pathology is broken links — "design written, resources prepared, pipeline not connected."** The restart period empirically evidenced multiple broken links, whose commonality was that design and resources were both ready, but the pipeline was not connected. Therefore, when investigating any "defect," one should first ask "is it a broken link" and then "has it been fixed," because the false-positive rate for such issues is relatively high.

The system was long trapped by four mutually obscuring layers of root causes: the verification layer could not see real problems (scoring inflation, loading does not equal effectiveness); the data layer inherently produced noise; the architecture layer's implementation contradicted the design (multiplication instead of spatial additive); and the process layer continuously generated complexity by oscillating between patches and framework-level fixes. The four layers mutually obscured each other until being progressively broken through across several generations. Among them, one fundamental paradigm shift was: from per-word inverted-index lookup (extremely high catch-all rate) to spatial-search dominance (dramatically reduced catch-all rate), which undermined the foundations of the early architecture.

---

## 6.4 Summary

This chapter, centered on the core thesis "resources are not lacking; positioning is," discussed the language resource system, the self-built lexicon system, and engineering norms and constraints, with a glossary and the system's current status roadmap as appendices. The three highest-priority norms can be re-anchored as follows:

First, the numerical-value stance: all numerical values in the system are experimentally calibrated or initial default values, and must be constrained and eliminated through experimentation rather than set arbitrarily. Before modifying a scoring formula, the actual value-range distribution must first be examined.

Second, soft isolation: hard filtering is strictly prohibited; soft isolation is mandatory. Multi-layer penalties chain-multiplied are equivalent to hard deletion and are equally in violation. Contamination should be treated at entry, not exit.

Third, lexicon: lexicon quantity is sufficient; what is lacking is positioning. The activation term layer and adapter inverted layer must be synchronously paired (values must be arrays). Admission must satisfy the six standards and comply with content red lines. Self-built lexicon data bodies are not public.

The algorithms and lexicons described in this chapter are in implemented, awaiting-reconnection-to-main-pipeline component state. The accurate external statement is: core algorithms are complete and have passed full-volume experimental closure; currently undergoing fine-tuning and main-pipeline integration.

---

*Acknowledgments: This system uses multiple publicly available open-source language resources and datasets in its association divergence, semantic vector, concept graph, sentiment dictionary, and other components. Sincere thanks are extended to the authors and maintainers of these resources. The relevant source list is maintained in the project documentation.*
