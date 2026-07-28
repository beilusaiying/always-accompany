# Chapter 6 The Vocabulary System

> The P1 vocabulary is not a lookup table but a system of cognitive coordinates. Each entry carries an 18-dimensional coordinate vector, a 47-axis distribution, a prior probability, and a bridging graph, and at runtime these jointly constitute a computable semantic space. This chapter gives a complete account of the system's architecture, dimensional structure, statistical distribution, construction methodology, auxiliary NLP modules, and project-specific terminology.

---

## 6.1 Vocabulary Architecture

### 6.1.1 Two-Layer Design: Activation Terms and Transfer Index

The P1 vocabulary consists of two interlocking data structures:

**Activation Terms (AT)** is the term ontology, storing the attribute vectors of all entries in JSON format. Each entry belongs to a "dimension" (dim), named in the format "discipline:sub-direction" (e.g., `psychology:therapy`); entries are indexed by term name under their dimension. AT is the core data source for P1's divergence and voting.

**Transfer Index (TI)** is an inverted index that maps colloquial user expressions to the professional terms in AT. For example, when a user says "好累不想动" (so tired, don't feel like moving), TI maps it to the information word "日常疲惫宣泄" (venting of everyday fatigue) in AT.

TI values must be Arrays rather than Objects; this format constraint was established as an inviolable rule after four violations during development each caused failures.

A strict dual-write constraint binds the two structures: any modification to AT must be synchronously applied to TI, otherwise the new term will never be hit because it lacks a trigger path.

### 6.1.2 Four Operating Modes

P1 physically partitions the vocabulary into four independent files by application scenario, each serving one operating mode. Table 6-1 shows, for each mode, its Activation Terms file, primary axis orientation, and example direction words.

**Table 6-1: Vocabulary isolation across the four operating modes**

| Mode | Activation Terms | Primary axis orientation | Example direction words |
|------|--------|---------|-----------|
| **chat** | chat-mode Activation Terms file | Psychology (therapy and prevention) | 认知重构 (cognitive restructuring), 价值澄清 (values clarification), 边界设定 (boundary setting) |
| **airp** | airp-mode Activation Terms file | Informatics (narrative structure) | 存档点 (save point), 信息疲劳 (information fatigue), 日常系 (slice-of-life) |
| **code** | code-mode Activation Terms file | Systems debugging (technical diagnosis) | Schema Mismatch, 差分诊断 (differential diagnosis) |
| **work** | work-mode Activation Terms file | Project decision-making (cross-disciplinary lenses) | Cynefin, 机会成本 (opportunity cost), OKR 对齐 (OKR alignment) |

At runtime, the vocabulary-merging module loads the per-mode Activation Terms file for the current mode and merges it with 6 supplementary JSON files into the complete vocabulary for that mode.

After 2026-05-23, the original master Activation Terms file was physically quarantined as a 42-byte placeholder file that throws an error on read, specifically to guard against accidental use of the legacy path—code consumes only the per-mode files, preventing cross-mode contamination.

### 6.1.3 Information Words and Direction Words

Vocabulary entries are functionally divided into two classes with entirely distinct roles:

**Information words (eligible = false)** are face-level concepts used to help P1 decompose the user's state. Information words are not emitted in the final output; they exist as an intermediate aggregation layer. Typical examples include "习得性无助" (learned helplessness), "冒充者综合征" (impostor syndrome), and "损失厌恶" (loss aversion). By design, the role of information words is to supply richer evidence and candidate possibilities for the generation of direction words—they are the intermediate carriers of the aggregation layer, not output objects.

**Direction words (eligible = true)** are line-level concepts, emitted to the main AI via the `p1_act` XML as reference directions for its reply. A direction word points to a cognitive, therapeutic, or analytical direction, not a concrete course of action. Typical examples include "认知重构" (cognitive restructuring), "价值澄清" (values clarification), and "行为激活" (behavioral activation). By design, direction words are reply-direction suggestions offered to the main AI, not judgments about the user's state—a constraint consistent with the "no scoring, no projection" principles among the four red-line rules (see Section 6.4.5).

The two classes are connected through a three-layer chain architecture (deployed 2026-05-23), as shown below:

```
用户口语 --(TI)--> 信息词(eligible=false) --(bridge_to)--> 方向词(eligible=true) --> p1_act
```

(User colloquial input --(TI)--> information word (eligible=false) --(bridge_to)--> direction word (eligible=true) --> p1_act)

This architecture allows multiple colloquial expressions to converge onto one information word, which then bridges precisely to a direction word, achieving a "many-to-one" aggregation effect. The system design explicitly fixes the aggregation direction as many-to-one—multiple information words converge onto one direction word—and classifies the one-to-many form found in early implementations, where a single information word fanned out to multiple direction words, as an anti-pattern requiring correction. This many-to-one semantics is isomorphic to the Hough many-to-one voting mechanism of Chapter 5 (Hough, 1962).

### 6.1.4 JSON Data Format

#### Complete AT entry format

The following shows the JSON structure of a complete AT entry:

```json
{
  "psychology:therapy": {
    "认知重构": {
      "pe": 0.70,
      "concepts": ["认知重构", "习得性无助", "全有全无", "灾难化"],
      "分数18维": [0.3, 0.1, 0.05, 0.2, ...],
      "output_eligible": true,
      "bridge_to": null,
      "axes_47": { "psychology": 0.8, "linguistics": 0.3, ... },
      "l1_summary": { "psychology": 0.6, "cognitive": 0.5, ... }
    }
  }
}
```

Table 6-2 shows the type, meaning, and value-range constraints of each field.

**Table 6-2: AT entry field definitions**

| Field | Type | Meaning | Value range / constraints |
|------|------|------|-------------|
| dim (outer key) | `string` | Directory layer, format "discipline:sub-direction" | e.g., `psychology:therapy`, `informatics:narrative` |
| term (second-level key) | `string` | Term name | A searchable professional term |
| `pe` | `float` | Prior Expectation, controls the base weight of being selected | 0.40--0.65 (upper bound 0.65 after clamping) |
| `concepts` | `string[]` | Colloquial user trigger phrases (2--4 characters), extracted from real data | Typically 5--8 phrases |
| `分数18维` | `float[]` | Per-dimension weights, consumed by coordAccum coordinate accumulation | 18 floats |
| `output_eligible` | `boolean` | Whether the entry is a direction word (true) or an information word (false) | `true` / `false` |
| `bridge_to` | `string[] \| object[] \| null` | List of direction words the information word bridges to | Array of direction-word names, or array of objects with `when_axis` + `weight` |
| `axes_47` | `object` | Score vector over the 47 sub-axes | 47-key (95% of terms) or 48-key (5%) |
| `l1_summary` | `object` | 6-dimensional primary-axis mean field | 6 dimensions including cognitive |

#### TI entry format

Correspondingly, a TI entry uses the following structure:

```json
{
  "好累不想动": [
    {"term": "认知重构", "dim": "psychology:therapy", "score": 0.7, "source": "ESConv"}
  ]
}
```

In this structure, each TI key is a possible colloquial user expression, and the value is an array whose elements each point to a term in AT, carrying a match score and a data-source marker.

#### The four output fields of the system

P1's final output to `p1_act` contains four standard fields:

- **K[]**: 3--6 searchable terms (seed words), forming the core of the divergence direction
- **linguistics**: 1 label selected from 12 pragmatic classification tags
- **logic_strong**: 0--1 label selected from 5 logical-finding tags
- **psychology_axis**: 0--1 label selected from 14 therapeutic direction words (note: therapeutic direction words, not diagnostic words)

---

## 6.2 The Dimensional System

### 6.2.1 Three-Level Dimensional Architecture

P1's dimensional system adopts a "large--medium--small" three-level architecture. The design uses the structure of a book as an analogy: "large" corresponds to the overall direction of the whole book, "medium" to the stackable local directions of the table-of-contents layer, and "small" to the term pool at the level of chapter body text—the three levels respectively provide coarse positioning, local superposition, and the supply of concrete entries.

- **Large (6 axes)** = disciplinary directions, the input-side disciplinary positioning layer
- **Medium (47 axes)** = sub-dimensions, the output-side divergence range
- **Small (AT terms)** = concrete professional terms

The design constraints further specify the division of labor: the 6 axes determine the divergence point, while the 47 axes provide coarse positioning on the output side, upon which expansion and production take place. The 6 axes and the 47 axes are entirely different—the 6 axes are input-side, the 47 axes are output-side, and the two are not in a hierarchical (parent-child) relationship.

### 6.2.2 The Six Primary Axes and Their Academic Sources

P1's six primary axes cover six fundamental disciplinary dimensions of human cognitive activity. Table 6-3 shows each axis's English identifier, disciplinary field, and role within P1.

**Table 6-3: P1's six primary axes and their academic sources**

| Axis | English identifier | Disciplinary field | Role in P1 |
|----|---------|---------|---------------|
| Psychology | `psychology` | Clinical psychology, cognitive psychology | Emotion recognition, therapeutic direction positioning |
| Linguistics | `linguistics` | Pragmatics, discourse analysis | Pragmatic classification, indirect speech act recognition |
| Sociology | `sociology` | Social psychology, interpersonal relations | Social roles, relationship dynamics analysis |
| Logic | `logic` | Formal logic, argumentation theory | Reasoning-type identification, logical findings |
| Informatics | `informatics` | Information science, narratology | Information structure, narrative pattern recognition |
| Cognitive science | `cognitive` | Cognitive science, neuroscience | Cognitive mechanisms, attention patterns |

The cognitive-science rationale for choosing these six axes is that together they cover the complete loop of human cognition: cognitive science handles the low-level processing mechanisms of information, psychology handles emotion and motivation, linguistics handles expression and communication, sociology handles interpersonal relations and roles, logic handles reasoning and judgment, and informatics handles narrative and structure.

The overall architecture can be summarized as centered on "cognitive science + linguistics + logic"—these three constitute the minimal complete basis for understanding human thought, while the remaining three axes (psychology, sociology, informatics) provide domain-specialized capability at the application layer.

Another key design constraint on the 6 axes is "emit faces, not lines": each axis must internally possess multi-dimensional judgment capacity—not 6 scalars, but 6 subspaces. This is consistent with the structural claim in Gardenfors's (2000) conceptual spaces theory that a domain is composed of multiple integrable dimensions.

### 6.2.3 Complete List of the 47 Sub-axes

The 47 sub-axes are the output-side divergence-range positioners of P1. The finalized sub-axis list from the design (totaling 36 items under the groupings below; the `axes_47` field in runtime data follows a 47-key schema) is as follows:

**Foundational disciplines (6 axes)**: informatics / psychology / physiology / linguistics / logic / sociology

**General-purpose (3 axes)**: common knowledge / programming / work

**Mode-specialized (1 axis)**: airp (role-play)

**Literature and narrative (8 axes)**: literary writing techniques / Japanese light novels / Chinese light novels / American fiction / character presentation / the three elements of fiction / anime / fiction plot

**Character and behavior (2 axes)**: personas / behavioral logic

**Language and logical analysis (2 axes)**: language logic / language analysis

**Psychotherapy (6 axes)**: psychotherapy / psychological analysis / common psychology direction words / cognitive behavioral therapy / dialectical behavior / interpersonal relations

**Psychoanalysis (1 axis)**: psychoanalysis

**Programming technology (5 axes)**: common programming knowledge / common programming error algorithms / data / difficult backend problems / difficult frontend problems

**Code diagnosis (1 axis)**: code bug inspection and reasoning

**Cross-tier issues (1 axis)**: frontend-backend multi-tier problems

In addition, about 95% of terms in the vocabulary data use the 47-key schema and about 5% use a 48-key schema (with one extra supplementary dimension); this inconsistency once caused the cosine distance computation to crash and is one of the identified P0-level bugs.

### 6.2.4 The 18-Dimensional Coordinate System

Besides the 6 axes and the 47 axes, P1 also uses an 18-dimensional coordinate system (ALL_DIMS) at the coordAccum layer for fine-grained positioning of terms in space. The 18 dimensions are listed below:

```
emotion / embodied / sensory / cognitive / narrative / logic /
temporal / spatial / process / valence / arousal / scene /
metaphor / object / psychology / sociology / pragmatics / relationship
```

For each AT entry, the `分数18维` field stores its weight values over these 18 dimensions. The relationship between the 18 dimensions and the 6 axes is as follows: the 18 dimensions are finer-grained coordinate axes used for coordinate accumulation computations in Phases A/B, whereas the 6 axes are higher-level disciplinary directions used for divergence positioning and axis-decay control.

---

## 6.3 Vocabulary Distribution Statistics

### 6.3.1 Overall Scale

As measured on 2026-05-30, the complete statistics of the P1 production vocabulary are shown in Table 6-4.

**Table 6-4: Overall scale of the P1 production vocabulary (measured 2026-05-30)**

| Mode | Dimensions (dims) | Total terms | Direction words (eligible) | Information words (info) | Info/direction ratio | TI triggers | Broken bridges |
|------|-------------|---------------|------------------|--------------|------------|---------|--------|
| code | 212 | 2,005 | 906 | 1,099 | 1.21 | 11,171 | 0 |
| chat | 538 | 4,525 | 2,081 | 2,444 | 1.17 | 26,722 | 0 |
| airp | 264 | 2,411 | 777 | 1,634 | 2.10 | 15,667 | 0 |
| work | 289 | 2,436 | 997 | 1,439 | 1.44 | 14,958 | 0 |
| **Total** | **1,303** | **11,377** | **4,761** | **6,616** | -- | **68,518** | **0** |

### 6.3.2 Ratio of Information Words to Direction Words

Across the full vocabulary, direction words account for 41.8% (4,761 entries) and information words for 58.2% (6,616 entries). The information-word/direction-word ratio per mode ranges from 1.17 (chat) to 2.10 (airp). The airp mode has the highest proportion of information words, reflecting the design intent that narrative signals in role-play scenarios rely more heavily on the intermediate aggregation layer.

### 6.3.3 Coverage Across Axes

The disciplinary fields covered by the vocabulary include: psychology, informatics, sociology, linguistics, logic, physiology, behavioral economics, common programming errors, IDE errors, algorithms, data, difficult backend problems, literary writing techniques, Japanese light novels, Chinese light novels, American fiction, character presentation, the three elements of fiction, anime, fiction plot, behavioral logic, cognitive-behavioral, dialectical behavior, interpersonal relations, psychoanalysis, general common knowledge, workplace management, and AIRP.

### 6.3.4 Health Metrics

Table 6-5 shows the quality metrics after the completion of eligible labeling on 2026-05-23.

**Table 6-5: Quality metrics of eligible labeling (2026-05-23)**

| Metric | Value | Verdict |
|------|-----|------|
| Bridge template rate | chat 5.8% / airp 10.7% / code 0% / work 0% | Normal |
| Bridge uniqueness rate | 75--87% | Normal |
| axes_47 clone rate | 0--0.2% | Normal |
| eligible coverage | 100% | Normal |
| Maximum pe | 0.65 | Normal (clamp upper bound) |
| Bridge-less words (noBridge) | 0 (all four modes) | Normal |
| Broken bridges (brokenBridge) | 0 (all four modes) | Normal |

### 6.3.5 Historical Evolution

Table 6-6 shows the key change points in the evolution of vocabulary size over time.

**Table 6-6: Historical evolution of the vocabulary**

| Point in time | AT total | Key change |
|---------|---------|---------|
| 2026-05-19 | 3,195 | chat 1,148 / airp 963 / code 371 / work 713 |
| 2026-05-23 eligible labeling + expansion | 10,883 | Direction words 3,390 / information words 7,493 |
| 2026-05-23 after the four-Opus repair | 11,013 | Direction words 4,629 (42%) / information words 6,384 (58%) |
| 2026-05-30 after code expansion | 11,377 | 112 new frontend words added for code |

Vocabulary version control is implemented through a complete backup chain in the backup directory, covering 12 version backups from v21--v36 (historical backup files of the Activation Terms; backup-chain version numbers are independent of the experiment version numbers v14--v35 in Chapter 7), with a physical backup taken before each major change.

### 6.3.6 Utilization of External Academic Resources

The P1 project has accumulated an NLP resource library totaling about 61 GB, but the actual utilization rate through code integration is under 1%. A system review classified this low resource-utilization rate as an item to improve, and raising the code-integration rate of high-value resources was established as an ongoing engineering goal.

Table 6-7 shows the 14 resources already integrated into code, including their data scale, license, and use within P1.

**Table 6-7: External academic resources integrated into code**

| Resource | Data scale | License | Use in P1 |
|------|---------|--------|-------------|
| cogmech_gemini.json | 9,134 words | Generated within the project | 6-axis scoreWord + polarity detection |
| NRC-VAD v2 | 54,801 words | Academic open use (NRC) | 6-axis scoreWord + polarity detection |
| affective_zh_11k | 25,044 words | Academic open use | VAD supplement (Chinese) |
| concreteness_78k | 87,942 words | Academic open use (Brysbaert et al.) | 6-axis scoreWord (concreteness) |
| Numberbatch 300-dim | 294,716 words | CC BY-SA 4.0 | Centroid + cosine distance + analogy + lateral inhibition |
| SWOW-ZH 2024 | 10,024 cue words | CC BY-NC-SA 4.0 | Core engine of associative divergence |
| ConceptNet inverted index (simplified) | 256,032 words | CC BY-SA 4.0 | Attributional divergence + hop2 paths |
| DLUT affective lexicon | 27,467 words | Academic open use (Dalian University of Technology) | Polarity inference |
| DomainWordsDict | 561,000 words (69 domains) | Open source | 6-axis scoreWord (domain positioning) |
| THUOCL | 11 domains | Open source (Tsinghua University) | 6-axis scoreWord (domain words) |
| BCC word frequency | 434,000 words | Academic use (Beijing Language and Culture University) | Function-word filtering + domain positioning |
| CoreNatureDictionary | 153,000 words | Open source (HanLP) | Function-word filtering |
| ESConv | Emotional support dialogue corpus | Academic open use | 128 TI entries integrated |
| NRC-Emotion-Lexicon | Affective lexicon | Academic open use | 405 TI entries integrated |

Note: the license descriptions in this table follow the same convention as Appendix C.4; the specific license terms are governed by each resource's original release page.

**Loaded but under-used (8)**: Glasgow 9-dim (5,500 words), Lancaster 11-dim (39,000 words), SSDD 6-dim, NRC-EmoLex (8 emotions), CFN-Lex (frame semantics), ATOMIC index (5,679 words, 0 lines of calls in code), overused_penalty.json (130 entries, 0 lines of calls in code), swow_indegree.json (9,841 words).

**High-value resources in the library not yet integrated (44)**: including OpenHowNet (2,000 sememes x 100,000 words), full ConceptNet (475 MB), ATOMIC 2020 (900,000 commonsense causal triples), the HIT synonym thesaurus Cilin (77,000 words), FrameNet v17 (1,222 frames), and others. By category: 8 positioning resources, 11 affect/psychology, 4 synonym/antonym, 3 cognition/logic, 6 narrative/ACG, 2 programming, 5 metaphor/analogy, 5 npm tools.

---

## 6.4 Construction Methodology

### 6.4.1 The Complete Pipeline from Raw Data to Finished Vocabulary

The construction of the P1 vocabulary follows a strict seven-step pipeline:

1. **Raw data sources**: ESConv emotional support dialogues, the DLUT affective ontology, the NRC affective lexicon, web search (Google / Baidu / Wikipedia), designer-distilled dialogues, academic dictionaries
2. **Term extraction**: professional terms are extracted from real dialogues and datasets; having the AI fabricate terms out of thin air is strictly forbidden (hard rule 14)
3. **Admission screening**: each entry is checked against 7 admission criteria (see Section 6.4.2)
4. **AT insertion**: the entry is placed into the activation_terms file of the corresponding mode, with all of pe / concepts / axes_47 / l1_summary / eligible / bridge_to annotated
5. **TI synchronization**: the transfer_index entry is created in the same operation (the mandatory dual-write constraint)
6. **Validation**: full 200-case validation + manual reading of at least 5 real `p1_act` outputs
7. **Backup chain**: physical backup on drive D, maintaining a complete rollback chain

Each batch of changes covers no more than 20 terms. The system design established a convergence principle for vocabulary scale: expansion is not an unbounded process—once the vocabulary reaches its coverage threshold, it should enter a long-term stable-use phase. This principle corroborates, and is corroborated by, the later ablation conclusion (Section 6.4.7) that once the vocabulary is sufficient, the quality bottleneck shifts to the algorithm layer.

### 6.4.2 Admission Criteria: 7 Admission Rules

All entries must simultaneously satisfy all of the following conditions:

1. **Searchable**: findable via Google / Baidu, with a Wikipedia / encyclopedia / academic page
2. **Known to the AI**: seen sufficiently often in the training data of large language models
3. **Consensual**: a term recognized by practitioners in the field, not a pseudo-term fabricated by an AI
4. **Is a direction word**: points to a cognitive / therapeutic / analytical direction
5. **Not a diagnostic word**: must be in the therapy-and-prevention direction (e.g., "认知重构" (cognitive restructuring)), never a diagnostic label (e.g., "焦虑障碍" (anxiety disorder))
6. **Not a route word**: gives a direction (e.g., "分散注意力" (diverting attention)), not a route (e.g., "去看番剧" (go watch anime))
7. **Not colloquial**: a professional term (e.g., "自我效能感" (self-efficacy)), not an everyday description (e.g., "温柔陪伴" (gentle companionship))

The core screening principle is the information-increment criterion: a word that the main model could derive on its own from a bare reading of the input is defined as a "null-value term" (zero increment); P1's value lies in providing cognitive directions that the main model would not easily reach spontaneously without prompting. This criterion is consistent with Mednick's (1962) theory of remote associates—the creative value of an association increases with semantic distance, and near-distance associations are the default path that any associating agent completes spontaneously.

### 6.4.3 Classification of Three Types of Words

**Type 1 -- Genuine terms (keep)**: standard academic vocabulary or industry-common terms, searchable and clearly defined. Examples: in psychology, "习得性无助" (learned helplessness) and "认知失调" (cognitive dissonance); in programming, "回调地狱" (callback hell) and "竞态条件" (race condition); in literature, "伏笔" (foreshadowing) and "三幕结构" (three-act structure); in AIRP, "OOC" and "角色弧光" (character arc).

**Type 2 -- AI-assembled pseudo-terms (delete)**: AI-fabricated words that sound professional but cannot be found by search. Their signature is a concatenated "genuine term + suffix" structure, e.g., "失望整合路径" (disappointment integration pathway), "自豪感锚定" (pride anchoring), "关系疲惫觉察" (relationship-fatigue awareness).

**Type 3 -- Instruction labels (do not put in the vocabulary)**: behavioral-instruction content such as "不要给阶段理论" (do not present stage theories) or "先问再答" (ask before answering); such content belongs in the system prompt, not the vocabulary.

### 6.4.4 Types That Must Be Eliminated

Table 6-8 summarizes the seven types of entries that must be eliminated and the reasons for their elimination.

**Table 6-8: Entry types that must be eliminated**

| Elimination type | Example | Reason for elimination |
|---------|------|---------|
| AI-fabricated descriptive phrases | "根深认知框架场景" (deep-rooted cognitive-framework scenario) | Not findable by search engines |
| Diagnostic labels | 焦虑障碍 (anxiety disorder), 抑郁症 (depression), PTSD | Violates the four red-line rules (no projection) |
| Route words / action words | 建议安慰 (suggest consoling), 去散步 (go for a walk) | Give directions, not routes |
| Colloquial descriptions | 温柔陪伴 (gentle companionship), 感到孤独 (feeling lonely) | Not professional direction words |
| Over-generic terms | 感官细节触发 (sensory-detail triggering), 情绪具体命名 (concrete emotion naming) | Match any input; no discriminative power |
| Pure English (Chinese-language scenario) | Confirmation Bias | Chinese users will not trigger it |
| Micro-decision words | 要不要约 (whether to ask someone out), 拉黑解封 (blocking and unblocking) | Belongs to P9 personalized learning |

### 6.4.5 The Four Red-Line Rules

P1 establishes four absolutely inviolable red-line rules:

1. **No creation** -- P1 does not create content; it only gives directions
2. **No scoring** -- P1 does not judge the user
3. **No projection** -- P1 does not guess the user's feelings or thoughts
4. **No system interference** -- P1 does not modify system behavior

### 6.4.6 Quality Gating

The quality of direction words is evaluated against 5 core properties (confirmed as intersection consensus by 3-way Opus cross-validation):

1. **A knowledge entry point, not a description**: "刻意练习" (deliberate practice) retrieves Ericsson's complete research framework; "坚持力差" (poor perseverance) corresponds to no retrievable body of knowledge
2. **A direction, not a route**: "分散注意力" (diverting attention) is a direction; "去看番剧" (go watch anime) is a route
3. **A therapeutic direction, not a diagnosis**: "认知重构" (cognitive restructuring) points toward a solution; "习得性无助" (learned helplessness) points toward a pathological label
4. **Must be searchable**: findable by search engines = seen in training data = the semantic node has high degree = activation is reliable
5. **4--6 seeds + 3 connecting lines**: high information density, small volume

### 6.4.7 Governance of Over-Generic Terms

An over-generic term (Universal Term) is a generalized entry that appears >= 5 times across 200 cases, covers >= 4 dims, and has >= 50 TI trigger words. Such entries match any input and have lost all discriminative capacity.

The design diagnosis of the over-generic-term problem is that the root cause lies in insufficient information content and the absence of multi-axis cross-validation. High-information inputs (such as a specific work title) form strong positioning signals, whereas over-generic terms obtain universally high scores across broad contexts precisely because too few axes participate in validation, the input carries too little information, and multi-axis joint confirmation is missing.

Key lessons discovered during the actual governance process:

- The Top 10 over-generic TI entries were all dead data—the code's `if(!dim) continue` skips them outright, so TI entries not present in AT can never be hit
- Three rounds of 7,000+ vocabulary edits produced a quality-improvement delta of approximately 0; the 22 over-generic entries (appearing >= 5 times) are an architectural floor, with the root cause in the BLQ voting mechanism rather than the vocabulary itself

Based on the above ablation evidence (quality delta of approximately 0 from 7,000+ vocabulary edits), the system established its final optimization priority ordering: code (algorithmic mechanisms) first, vocabulary second, LLM third—the vocabulary has reached its sufficiency threshold, and the remaining quality bottleneck lies in the scoring and voting mechanism layer rather than the entry-coverage layer.

---

## 6.5 Auxiliary NLP Modules

The P1 vocabulary system is supported by 5 auxiliary NLP modules providing vector computation, coordinate lookup, associative divergence, online learning, and corpus-frequency analysis.

### 6.5.1 Numberbatch (the NB300 Vector Space)

**Module**: Numberbatch vector module (384 lines)

Numberbatch is the vector foundation of P1's divergence and coordinate computation, based on the ConceptNet Numberbatch word embeddings of Speer & Lowry-Duda (2017). The module loads about 294,716 Chinese words (each a 300-dimensional Float32Array vector) and 516,782 English words (true 300-dimensional vectors rebuilt from the original numberbatch-en-19.08 release, aligned in the same space as the Chinese vectors).

Table 6-9 shows the core capability functions exposed by the Numberbatch vector module, their functions, and their callers.

**Table 6-9: Core capabilities of the Numberbatch vector module**

| Function | Capability | Caller |
|------|------|--------|
| `cosineSimilarity(w1, w2)` | Cosine similarity between two words | Null-value-term detection (cos > 0.7 = too close = null-value term) |
| `findNeighbors(word, opts)` | Single-word neighbor search (minSim--maxSim band-pass filtering) | 6-axis fallback nearest-neighbor divergence |
| `findNeighborsBatch(words, opts)` | Batch neighbor search (one shared full-library scan) | SWOW + NB joint divergence |
| `findFromCentroid(words, opts)` | Multi-word centroid neighbor search | Pool divergence (rather than word-by-word divergence) |
| `findBridge(w1, w2, opts)` | Midpoint bridge-word search between two words | Cross-domain bridge discovery |
| `findAnalogy(A, B, C, opts)` | Vector-arithmetic analogy A:B :: C:? (Mikolov 2013) | Analogical divergence |

**TTEN + PCA debiasing**: after loading, TTEN debiasing (following CIKM 2023 + KDD 2026) is applied to all vectors: Power Iteration finds the first principal component, then the projection along pc1 is subtracted with a conservative coefficient alpha = 0.3. This treatment removes the bias whereby over-generic terms have large norms and convergent directions in the vector space.

**Performance**: first load takes about 14 seconds (streaming read of txt); subsequent startups read a `.bin` binary cache about 5x faster. A process-level singleton avoids repeatedly loading the 280 MB of vector data.

### 6.5.2 wordCoords (47D Coordinate Bridging)

**Module**: word-coordinate lookup module (1,061 lines)

wordCoords is P1's hub for multi-dimensional word-coordinate lookup, unifying more than 10 external resource libraries behind a single coordinate interface and implementing a "multi-library blend, take the best" coverage strategy—the design follows the idea of LLM word embeddings representing words as multi-dimensional coordinates, selecting the best coordinate source for each word through multi-library complementarity.

Table 6-10 shows the resource libraries loaded by the word-coordinate lookup module, their scales, and their functions.

**Table 6-10: Resource libraries loaded by the word-coordinate lookup module**

| Data layer | Resource | Scale | Function |
|--------|------|------|------|
| Part of speech (POS) | jieba_dict.txt | -- | Function-word filtering, noise-word identification |
| Concreteness | concreteness_78k + concreteness_zh + Brysbaert | 87,942+ words | Concrete--abstract degree for 6-axis scoreWord |
| Affective VAD | NRC-VAD + affective_zh_11k + Warriner + NRC-VAD v2.1 + EmoBank | Multi-source merge | Valence--arousal--dominance three-dimensional affective coordinates |
| Psychological attributes | Glasgow 9-dim | 5,500 words | Arousal, valence, dominance, concreteness, imageability, etc. |
| Cognitive mechanisms | cogmech_gemini | 9,134 words | Cognitive-mechanism labels (one source of 6-axis scoreWord) |
| Emotion categories | NRC-EmoLex (Chinese) | -- | 8 basic-emotion labels |
| Frame semantics | CFN-Lex | -- | Chinese FrameNet lexical frames |
| Semantic dimensions | SSDD 6-dim | -- | Vision, motion, sociality, emotion, time, space |
| Sensorimotor | Lancaster 11-dim | 39,000 words | 11 sensorimotor coordinates (auditory, gustatory, haptic, etc.) |
| Commonsense causality | ATOMIC index | 5,679 words | Commonsense event reasoning |

**Key algorithms**:

- **C1 de-collapse transform** (`c1TransformA47`): in axes_47, the cross-disciplinary dimensions (sem_/sm_ prefixes) have all-positive raw values that inject a shared positive bias, which under raw cosine paradoxically inflates same-discipline cosine values. The solution is to de-midpoint the sem/sm blocks dimension-wise (subtracting the dimension-neutral value 0.5 on the 0--1 normalization) so they become zero-mean and discriminable, then multiply by a weight W = 3 to compensate for the dominance of the disciplinary dimensions. The empirically optimal region: cosine < 0.7 for dissimilar word pairs and cosine > 0.8 for near-synonym pairs.
- **Sweet-spot inverted-U scoring** (`sweetSpot`): `Score = d / (1 + alpha * d^2)`, maximized at `d* = 1 / sqrt(alpha)`; used in BLQ voting to determine the optimal "neither too near nor too far" distance.
- **IB Tradeoff** (`ibTradeoff`): a cost-benefit function grounded in relevance theory—too near = redundancy (Effects = 0), too far = noise (Effort = infinity), optimal in between.
- **ZH VAD Override**: corrects VAD annotation errors for high-frequency Chinese words (diagnosed 2026-04-29). The root cause is that character-compositional Chinese VAD composes "想" (think/miss) + "家" (home) into a positive value (0.66), whereas "想家" (homesickness) is in fact a negative emotion. Manually verified VAD values override the erroneous annotations.

### 6.5.3 axisLearning (Online Learning)

**Module**: axis-learning module (273 lines)

axisLearning implements P1's three-layer online learning mechanism. Its design follows the self-learning paradigm of input-method lexicons: frequently occurring user words are recorded and gradually up-weighted, so that the vocabulary personalizes continuously with real usage—the long-term goal is for the vocabulary to be built mainly by the system through use, rather than depending on full manual maintenance.

**Three-layer learning structure**:

**Layer 1 -- Axis learning (accumulateAxisStats)**: after each round of P1 recall, axis_alignment statistics are accumulated into `axis_stats.json`. Memories actually cited by the main AI receive doubled weight (x2), because "what the main AI actually chose is stronger evidence that the axis is useful."

**Layer 2 -- Word-frequency learning (accumulateWordFreq)**: records user input word frequencies (`word_freq.json`), adjacent-word co-occurrence pairs (`user_cooccur.json`), and missing-word detection (`new_words.json`). Word frequencies are recorded with a day ordinal (epoch day) as the temporal dimension.

**Layer 3 -- Axis-weight calibration (calibrateAxisWeights)**: invoked offline by the P9 meta-AI, calibrating axis weights using the accumulated statistics. Updates use exponential-moving-average (EMA) smoothing: `new = old * (1 - learnRate) + target * learnRate`, with learnRate defaulting to 0.3 and weights clamped to the range 0.5--2.0. A minimum of 20 samples is required to trigger an update.

**Up-weighting function (userFreqBoost)**: used during P1 divergence to up-weight the user's frequent words; the algorithm is sublinear TF damping (a standard in information retrieval): `min(0.3, log(1 + count) * 0.1)`, capped at 0.3, ensuring that frequency up-weighting remains a bounded secondary bonus and does not dominate the ranking.

All disk writes execute asynchronously in fire-and-forget fashion, never blocking the main chain, and are serialized through `withFileLock` to prevent lost updates across concurrent rounds.

### 6.5.4 The SWOW Association Network

The SWOW (Small World of Words) association network is the core data source of P1's divergence engine, implemented in the `swowDiverge` function of the word-coordinate lookup module.

**Data sources**:
- SWOW-ZH 2024 official release (`swow_zh24_official.json`), 10,024 cue words, each with an associate list, strength weights, and rank ordering
- SWOW-EN (`swow_en_full.json`), about 12,000 cue words

**Query strategy**:
- Chinese words query the Chinese SWOW first, falling back to English if not found
- English words query the English SWOW first, falling back to Chinese if not found
- Substring matching and single-character-split fallbacks are disabled (they produce literal-form noise: "转行" (changing careers) -> "行" -> "不行/行人" (no good / pedestrian))
- Synonym fallback: synonyms are looked up via `synonym_index.json` before querying SWOW again

**Distance gate**: callers may pass `{distance: 'on', cosToAnchor}` to discard associates whose cosine with the anchor word is too high (default threshold 0.85, configurable via the environment variable `P1_N2_SWOW_DISTANCE_MAXCOS`), enforcing the divergence-distance design constraint: association targets should lie at medium-to-far distance (distance 4--5), and distance = 1 synonym diffusion is forbidden—synonymous nearest neighbors yield no information increment.

The core design semantics of SWOW divergence is additive convergence: the association dimensions of several similar input words are summed, so that jointly indicated directions are naturally reinforced while incidental noise associations naturally cancel out (the "addition-as-filtering" principle); the operational unit of divergence is a set of words, not a single word. This design is consistent with CombSUM multi-source fusion (Fox & Shaw, 1994) and with the semantics of spreading-activation theory in which activation accumulates additively along the network (Collins & Loftus, 1975).

### 6.5.5 BCC Corpus Frequencies

BCC (the Modern Chinese Corpus of Beijing Language and Culture University) frequency analysis is implemented in the BCC domain-analysis module (141 lines), providing three-domain word-frequency differentiation.

**Three-domain resources**:
- `dialogue_word_freq.txt`: 142,580 words (everyday dialogue)
- `literature_word_freq.txt`: 215,429 words (literature/fiction)
- `news_total_word_freq.txt`: 591,368 words (news/current affairs)

Table 6-11 shows the core functions of the BCC domain-analysis module and their outputs.

**Table 6-11: Core functions of the BCC domain-analysis module**

| Function | Capability | Output |
|------|------|------|
| `wordDomainDist(word)` | Normalized three-domain distribution of a single word | `{dialogue, literature, news}` |
| `getBccDomainProfile(words)` | Domain profile of a whole text passage | `{dialogue, literature, news, dominant, coverage}` |
| `computeModernPos(words)` | True computation of modern_pos | 0.0 (purely literary) -- 1.0 (purely everyday dialogue) |

The BCC three-domain differential serves as a coarse-grained scene signal: dialogue > 0.45 leans toward the psychology/social axes, high literature values lean toward narrative/role-play scenarios, and high news values lean toward formal/work scenarios. The dominant-domain threshold is 0.42 (slightly above the uniform share of 1/3, to avoid forced classification when no domain clearly dominates).

The BCC segmentation module (89 lines) provides forward maximum-matching segmentation based on the BCC frequency data, serving as a zero-dependency alternative to jieba segmentation.

---

## 6.6 Project-Specific Terminology

The following is the complete list of core coined or specialized terms used in the P1 project:

### 6.6.1 System Architecture Terms

Table 6-12 lists the core coined terms at the system-architecture level and their definitions.

**Table 6-12: System architecture terms**

| Term | English | Definition |
|------|------|------|
| 自驱动 P1 | Self-Driven P1 | P1's core operating mode: pure local operation at 0 API cost, achieving divergence through vocabulary + vectors + algorithms |
| AIP1 | AI-Powered P1 | A P1 variant based on the larger project, permitted to schedule two AIs in a single dispatch, layering LLM divergence on top of the self-driven base |
| 体面线点 | Body-Face-Line-Point | P1's geometric-hierarchy analogy: body = complete information, face = information words, line = direction words, point = the concrete reply |
| 激活词表 | Activation Terms (AT) | The term ontology, storing all entries and their multi-dimensional attributes |
| 传输索引 | Transfer Index (TI) | The inverted index mapping colloquial user language to AT terms |
| 信息词 | Information Word | Internal aggregation-layer entry (eligible = false), helping P1 decompose the user's state; never emitted |
| 方向词 | Direction Word | Output-layer entry (eligible = true), providing direction references to the main AI |

### 6.6.2 Algorithm and Formula Terms

Table 6-13 lists the core terms at the algorithm-and-formula level and their definitions.

**Table 6-13: Algorithm and formula terms**

| Term | English | Definition |
|------|------|------|
| BLQ | Beilu Linqing Quality | The scoring apparatus inside the transfer adapter, performing multi-factor voting and ranking over divergence candidates (the adapter contains BLQ; the relationship is containment, not equivalence) |
| 收拢-发散-收拢 | Converge-Diverge-Converge | P1's three-stage operating mechanism: Phase A convergence (recall) -> Phase B divergence (SWOW) -> Phase T convergence (BLQ voting) |
| 轴衰减 | Axis Decay | Design semantics: a weight allocation of roughly 80% to the primary direction and roughly 20% to secondary directions—decaying across axes without deletion; implemented as exponential decay over relevance rank (see Appendix B.1) |
| Sweet-spot 倒 U 型 | Sweet-spot Inverted-U | The scoring formula `d / (1 + alpha * d^2)`, optimal at intermediate distance |
| IB Tradeoff | Information Bottleneck Tradeoff | A cost-benefit balancing function grounded in relevance theory |
| 加法即过滤 | Addition-as-Filtering | Summing the dimension attributes of several similar words: the shared direction naturally becomes strongest, incidental noise naturally weakest |
| 信息池发散 | Pool Divergence | Divergence not word by word, but by pooling the information of multiple words and finding neighbors in space |
| C1 去坍缩 | C1 De-collapse Transform | The cosine-consumption transform for the cross-disciplinary dimensions of axes_47, eliminating the discriminability collapse caused by positive bias |
| TI-IDF | TI-Inverse Document Frequency | P1's proprietary variant of term frequency-inverse document frequency |
| PathHarmony | Path Harmony | A path-coherence score measuring the disciplinary span and coherence of a divergence path |

### 6.6.3 Data and Space Terms

Table 6-14 lists the core terms at the data-and-space level and their definitions.

**Table 6-14: Data and space terms**

| Term | English | Definition |
|------|------|------|
| NB300 | Numberbatch 300D | The ConceptNet Numberbatch 300-dimensional vector space, P1's vector infrastructure |
| 6 轴 | Six Axes | The input-side disciplinary positioning layer: psychology / linguistics / sociology / logic / informatics / cognitive science |
| 47 轴 | 47 Sub-axes | The output-side divergence-range positioner, covering 47 sub-dimensions |
| 18 维 | 18 Dimensions (ALL_DIMS) | The 18-dimensional fine-grained coordinate system used by coordAccum coordinate accumulation |
| pe 值 | Prior Expectation | The prior probability controlling an entry's base selection weight, range 0.40--0.65 |
| 必双合 | Must-Sync-Pair (AT-TI dual-write consistency) | The synchronization constraint between AT and TI: modifying one requires synchronously modifying the other |
| 桥接 | Bridge | The connection by which an information word points to direction words via the bridge_to field |

### 6.6.4 Quality Control Terms

Table 6-15 lists the core terms at the quality-control level and their definitions.

**Table 6-15: Quality control terms**

| Term | English | Definition |
|------|------|------|
| 万金油 | Universal Term (over-generic term) | A generalized entry that matches any input (appearing >= 5 times across 200 cases) |
| 废词 | Dead Term (null-value term) | A word the main model could derive from a bare reading of the input; providing it adds nothing |
| 路线词 | Route Term | A concrete action-instruction word (e.g., "去散步" (go for a walk)), violating the "directions, not routes" principle |
| 四红线 | Four Red Lines | No creation / no scoring / no projection / no system interference |
| AI 组装伪术语 | AI-Assembled Pseudo-term | An unsearchable coinage assembled by an AI from a genuine term plus a suffix |
| TTEN 去偏 | TTEN Debiasing | Removal of the first principal component (PCA) from the vector space, eliminating the over-generic-term bias |

### 6.6.5 Operating Mechanism Terms

Table 6-16 lists the core terms at the operating-mechanism level and their definitions.

**Table 6-16: Operating mechanism terms**

| Term | English | Definition |
|------|------|------|
| Phase A | Phase A (Recall) | The convergence stage: memory recall + qualitative analysis |
| Phase B | Phase B (Diverge) | The divergence stage: SWOW association network + multi-path spreading |
| Phase T | Phase T (Transfer) | The transfer stage: BLQ multi-factor voting -> final direction-word output |
| QKV | Query-Key-Value | The three-way annotation at the LLM layer: Q = user question, K = topic-referenced background, V = affective-statement information (same name as, but distinct from, the "QKV pool intersection divergence" algorithmic mechanism in Appendix B) |
| 六度分隔 | Six Degrees of Separation | The path-generation mechanism, reducible to 2--3 steps, halting automatically when connections become too weak |
| 类比发散 | Analogical Divergence | Extracting a relational skeleton and finding its isomorph in an entirely different domain (Linqing: "灵光一现，但有理有据" (a flash of insight, yet well-grounded)) |
| distance 门控 | Distance Gate | Filtering, during SWOW divergence, of synonym diffusion whose cosine with the anchor word is too high |
| 三层学习 | Three-Layer Learning | axisLearning's three layers of online learning: axis learning / word-frequency learning / missing-word detection |
| fire-and-forget | Fire-and-Forget | The asynchronous disk-write strategy that never blocks the main chain |

### 6.6.6 Linqing's Original Analogy System

Table 6-17 lists the original analogies used by Linqing to explain P1's mechanisms and their correspondences.

**Table 6-17: Linqing's original analogy system**

| Analogy | Source domain | Corresponding P1 mechanism |
|--------|------|-----------|
| Mendeleev-style extrapolation | The periodic table of chemistry | Vocabulary-gap detection / P9 personalized supplementation |
| Protein folding | Biochemistry | Spatial concepts / parameter alignment |
| Input-method lexicon | Input methods | The P1 vocabulary / P9 self-learning (axisLearning) |
| Recommendation engines / short video | Internet recommendation | P1's overall positioning ("recommendations pushed to the AI") |
| Pattern differentiation and treatment in traditional Chinese medicine | Traditional medicine | Multi-dimensional collection -> positioning -> direction |
| The Elder Scrolls V | Games | The beilu framework + plugins + community vocabularies |
| Regular-expression memory | Programming | A specific pattern match = a fragment hook pulling out a memory chain |
| Polymorphism (ritonavir) | Pharmaceutics | LoRA training stability |
| CPU multithreading degradation | Computing | High-energy multitasking -> fatigue rumination |

---

*All data in this chapter are based on production measurements of 2026-05-30 and deep code reading. The vocabulary backup chain is at version v34 (backup-chain version numbers and the Chapter 7 experiment version numbers v14--v35 are two independent numbering schemes); the code resides in the vocabulary-merging module (AT merging), the divergence module (BLQ voting), the Numberbatch vector module (vector space), the word-coordinate lookup module (coordinate lookup), the axis-learning module (online learning), and the BCC domain-analysis module (corpus frequencies). License information for external resources is annotated at each point of citation.*
