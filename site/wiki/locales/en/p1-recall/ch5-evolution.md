# Chapter 5 System Evolution and Experimental Evaluation

## 5.1 Introduction

This chapter chronicles the complete evolution of the P1 self-driven Divergence & Recall system (hereafter "the system") from its initial monolithic prototype to the current node-pipeline architecture, and provides systematic experimental evaluation. The system's design objective is to build an external association chain that does not depend on a large language model (LLM) — given user input, it diverges along multiple disciplinary dimensions in a spatial manner, recalling directional knowledge that the primary model itself would have difficulty associating, as supplementary cues for subsequent generation. The designer summarized this objective as "an external divergence thought-chain."

Unlike systems evaluated by a single metric such as accuracy or perplexity, this system's evaluation presents two special difficulties. First, divergence quality lacks a natural binary right-or-wrong signal, and scoring itself is highly dependent on the evaluator's calibration, easily leading to systematic inflation. Second, the system's core failure mode — the "catch-all problem" (where a small number of terms score high for virtually any input and repeatedly appear at the top of the output; see Section 5.7) — is insidious and is often masked by data-volume effects on small test sets. Accordingly, this chapter incorporates the evaluation framework, metric definitions, failure case analyses, and ablation records, aiming to support every design decision with experimental evidence.

It should be noted that the algorithm pipeline described in this chapter is an implemented component library. Since July 2026, the designer removed both the self-driven divergence pipeline and the native recall pipeline as independent component-state modules; live production shifted to LLM-preset-based retrieval. What this chapter describes are the implemented, awaiting-reconnection component-library algorithms and their experimental records.

The chapter is organized as follows: Section 5.2 covers the three-stage evolution history; Section 5.3 covers the key design decision timeline; Section 5.4 covers the evaluation framework and metric definitions; Section 5.5 covers the scoring trajectory (experimental results); Section 5.6 covers experimental records from the phased restart period; Section 5.7 covers the canonical failure case analysis (the catch-all problem); Section 5.8 covers the failed-approach compendium and ablation value; Section 5.9 is the summary.

---

## 5.2 System Evolution History: Three-Stage Architectural Paradigm Shifts

The system's architecture went through three stages (hereafter called three "eras"), each transition driven by a paradigm-level insight update rather than mere code rewriting.

### 5.2.1 Three-Generation Overview

| Era | Form | Core composition | Status | Time span |
|------|------|---------|------|---------|
| First generation | Monolith | Single entry file (later split into divergence and utility submodules) | Retired | April 26 – May 24, 2026 |
| Second generation | Three-file | Recall, axis system, and divergence as three file-level modules | Retired | Finalized around May 24, 2026 |
| Third generation | Node pipeline (current production) | Main pipeline orchestrator + individual function node modules | Current production | From May 25, 2026 onward |

### 5.2.2 Each Generation's Form and Reasons for Replacement

**Three hard reasons the first generation (monolith) was abandoned:**

First, size was out of control. By May 7, 2026, the monolithic file had reached 483,452 bytes and 7,813 lines, triggering a crash incident. Second, maintainability was lost. Three consecutive iteration plans repeatedly diagnosed the same chronic issues yet consistently failed to fix them — the monolith was highly coupled, and modifying any part could trigger a system-wide collapse. Third, and most fundamentally, the underlying paradigm was overturned: the old paradigm, dominated by per-word inverted-index lookup, had a catch-all rate of 74%; after switching to spatial-search dominance, this dropped to 4% (see Section 5.2.4).

**Reason the second generation (three-file) was abandoned:** The three-file structure was still file-level linear invocation, unable to support hot-swapping, white-box instrumentation, or pipeline switching at node granularity. The third generation replaced linear invocation with pipeline orchestration to support multiple switchable pipelines. It is worth emphasizing that the transition from second to third generation was not a paradigm overhaul but a reorganization, renaming, and orchestration — the original divergence submodule was directly renamed and carried forward as the third generation's divergence node.

**The third generation (node pipeline) continues to evolve:** A critical architectural contraction occurred between May 30 and 31, 2026, rolling back the coordinate-collapse mechanism to range gating plus scoring. The designer established the principle: scoring is the responsibility of the scoring module, not the axis system; the axis system is only responsible for providing positioning for divergence. The third generation supports three parallel pipelines, differentiated by the position of the LLM integration point (no LLM / before semantic diffusion / after semantic diffusion) — this position is the core variable of pipeline switching.

### 5.2.3 Two Calibrations for the Era Starting Point (Both Retained)

Regarding the starting point of the second generation, two calibrations coexist in historical archaeology, and this chapter does not adjudicate: first, treating the split of divergence and utility submodules on May 9, 2026 as the embryonic second generation; second, treating the recall/axis-system/divergence three-file set finalized by renaming on May 24, 2026 as the formal second generation, holding that the two are not the same set of files. Both calibrations are historical-temporal archaeology and are retained side by side.

### 5.2.4 Core Paradigm Shift: Per-Word Lookup (74%) to Spatial Search (4%)

This is the most significant paradigm shift in the system's history. It directly undermined the foundations of the first generation and was the fundamental driver of the restructuring from the first generation to the subsequent two.

| Paradigm | Dominant mechanism | Catch-all rate |
|------|---------|---------|
| Old paradigm (first generation) | Per-word inverted-index lookup | 74% |
| New paradigm | Spatial search (centroid/range as core) dominant | 4% |

The reduction from 74% to 4% is quantitative evidence. At the design level, the qualitative diagnosis was: the old implementation suffered from objective-function inversion — the system's design intent was an association engine, but the implementation had degenerated into a retrieval engine, turning spatial divergence into per-word lookup and factor multiplication. This "objective-function inversion" chronic issue spans all three generations and is the main thread for understanding the system's entire evolution.

---

## 5.3 Key Design Decision Timeline

This section traces the evolution of ten core design dimensions along a timeline, showing how design intent progressively converged through experimental feedback.

### 5.3.1 Axis System: 4 Axes to 5 Axes to 6 Axes

The axis system refers to the set of disciplinary dimensions upon which divergence is based. Its evolution path was: the designer's initial conception comprised four main axes — linguistics, QKV, logic, and information science (April 23, 2026); the implementation layer once expanded to an eighteen-dimension set (approximately late April to May 6); the designer then confirmed four main axes plus dynamic axis addition (May 6 calibration); this was further fixed to five core axes (May 10); finally, QKV was moved out of the axis layer and information science was substituted in, yielding five fixed axes: psychology, information science, sociology, logic, and linguistics (May 11).

A key ruling was the designer's rejection of the implementation layer's self-invented attention-style QKV axis, pinning the main axes to disciplinary axes (psychology, information science, sociology, logic, linguistics). The implementation layer had repeatedly mistaken QKV for an axis and was corrected three times.

The axis count has two calibrations — current and historical — both retained: the current production code implements six axes, adding cognitive science to the five axes above (the current handwritten framework examples list information science, logic, psychology, sociology, and cognitive science — thus the current framework already includes cognitive science); some historical evolution documents record "final five fixed axes (excluding cognitive science)," which was the historical state as of May 11, 2026. The current description uses six axes as the standard; the five-axis evolution line is included only in the evolution history.

### 5.3.2 Decay Mechanism: Four Stages

The decay mechanism controls the influence of secondary axes during along-axis divergence, preventing divergence from deviating from the primary direction. Its evolution comprised four stages: (1) Concept proposal — when axes other than the main axis are involved, they are additionally overlaid but must decay so as not to affect the primary force (April 23). (2) Three-tier decay — exponential form exp(-axis_distance × β), β taking three tiers 0.5/1.0/1.5, main-axis weight 1.0, secondary axis 0.5–0.7, distant axis 0.1–0.3. (3) Soft-isolation principle established — the designer established the engineering iron rule of "implementing mode filtering through soft filtering rather than hard filtering" (May 11). (4) Axis decay implemented — default decay coefficient is an experimentally calibrated fixed value of 0.5, in the form exp(-axis_ordinal · β).

An implementation deviation from the design is recorded: the designer's intent was to use the natural decay of high-dimensional bundling (the more items overlaid, the more each individual is diluted); the implementation instead used a hardcoded distance matrix (adjacent distance 0→1.0, 1→0.6, 2→0.25) as manually set parameters. Additionally, the relevance decay truncation threshold is 0.40, derived from the designer's algorithm constant "do not diverge if relevance is below 40%."

### 5.3.3 LLM Role Evolution

A core belief of this system has remained unchanged since inception: LLMs are "contraction machines," and divergence must be externalized. The LLM's role narrowed accordingly — from performing QKV annotation (May 6), to outputting multiple annotations and a small number of scalars (May 8), to being corrected the same day to "only provide direction, not formulas or numbers," and finally having its identity changed from "annotation expert" to "tag generator" to prevent creative elaboration (May 9).

The designer drew four red lines for the LLM: no creation (rely on original text and recall, with only small-scale closed enumerations), no scoring (no numeric fields in output), no projection (do not speculate on what the user has not stated), and no system influence (output only annotations, do not alter the main pipeline). A distinction must be drawn between the design vision and the implemented status: the LLM's multi-head annotation layer has not yet been fully implemented; in practice, it only performs simple scalar classification. The designer's intent for this layer is that the LLM only clarifies direction, annotates QKV, and segments conversations — producing absolutely no creative content, only understanding and annotation on original content; many issues could be resolved simply by optimizing QKV well. This is a design vision, not an implemented capability, and must be distinguished when evaluating.

### 5.3.4 Scoring Method Evolution

The scoring method underwent a transformation from rule-based scoring to multi-dimensional soft activation. Early approaches used pure tier descriptions and numeric mappings (with one known erroneous mapping); v4 adopted rule-based scoring with a ceiling of 4 points (decided by the implementer); experiments found rule-based scoring to be inflated by 58% (May 10); v5 changed to five-dimension soft activation with calibration minus-one and a ceiling of 5 points (corrected May 11). Rule-based scoring inflation has empirical evidence: the designer's manual score was approximately 2 points, while the probe yielded 3.5 points or above; coarse evaluation 2.0 (inflated), 12-example manual evaluation 0.92, and 200-example five-dimension strict evaluation 0.72 (most trustworthy). This established the iron rule: never use automated coarse evaluation as a decision basis (its inflation is at least 1 point).

### 5.3.5 Divergence Method Evolution

The divergence method's evolution path was: spreading activation theory discussion (April 23); semantic diffusion plus adapter basic framework (late April); algorithm migrated to adapter-side BLQ (April 30); six-mechanism parallel stage (May 8 code); three-layer matching design corrected the same day to QKV plus direction plus contextual relevance (May 8); main-axis plus along-axis divergence (May 10); five-axis distribution plus decay plus analogy with five fixed axes (May 11, final).

### 5.3.6 BLQ Factor Count Evolution (Retained Side by Side, No Adjudication)

BLQ is the system's core scoring subsystem. Its factor count has been repeatedly added and removed throughout history, with inconsistent accounts across versions — all are listed without lockdown:

| Stage | Form | Factor count |
|------|------|--------|
| Early | Factor chain multiplication (gate × rank × boost) | 6 → 9 → 10 → 11 → 13 |
| Expansion | Factors continued to increase | 13 → 16 → 17 |
| One rewrite | Approximately 290-line six-node structure replacing the old approximately 3,000-line, 13–17 factor implementation | N1–N6 |
| Later | 10 factors plus Reciprocal Rank Fusion (RRF) | 10 |

An audit fact corroborating the "code is truth, comments are suspect" principle: one version's header comment claimed "13-factor full product," but the actual implementation was "5-factor average"; the outer multiplicative switch defaulted to chain multiplication, contrary to the "spatial additive" design (the additive version was off by default); three incompatible interfaces shared the same scoring function name. The designer's later ruling: BLQ has actually only completed ranking (ten-factor scoring) and still requires further optimization. The current description uses the additive multi-dimensional framework as the standard (six additive dimensions plus four suppression dimensions; see the algorithm chapter), and the factor count's historical evolution is included only in the evolution history.

### 5.3.7 Design Override Summary Table

The table below summarizes the complete "overridden design → overrider" transitions, showing how the design self-corrected through iteration:

| Overridden design | Overrider | Core change |
|---|---|---|
| Four main axes (linguistics / QKV / logic / information science) | Five fixed axes (psychology / information science / sociology / logic / linguistics) | QKV moved out; psychology and sociology added |
| Fourteen-dimension regionalization (not implemented) | Eighteen-dimension set (implemented) | From design to implementation |
| Three-layer matching (static lexicon routing) | QKV plus direction plus contextual relevance (dynamic annotation) | Corrected same day; LLM introduced |
| Ceiling of 4 points (v4) | Ceiling of 5 points (v5) | Reverted implementer's unauthorized decision |
| Rule-based scoring | Five-dimension soft activation with calibration | Word checklist to multi-dimensional quality evaluation |
| "Annotation expert" identity | "Tag generator" identity | Prevented creative-role implication |
| Cross-disciplinary flat divergence | Along-main-axis divergence with decay | From flat to along-axis; core innovation |

---

## 5.4 Evaluation Framework and Metric Definitions

The system's evaluation combines manual scoring with quantitative metrics. The core difficulty lies in resisting scoring inflation and small-sample self-deception.

### 5.4.1 Five-Dimension Scoring and Per-Mode Scoring Criteria

The v5 scoring uses five-dimension soft activation with calibration minus-one, ceiling of 5 points (corrected May 11, 2026, replacing v4 rule-based scoring). The true calibration three-tier: coarse evaluation 2.0 (inflated), 12-example manual evaluation 0.92, 200-example five-dimension strict evaluation 0.72 (most trustworthy).

The system sets separate scoring criteria for four operating modes (chat / airp scenario / work / ide coding). The scoring criteria from 5 (optimal) to 1–2 (poor) for each mode are as follows:

| Mode | 5 (optimal) | 4 (excellent) | 3 (moderate) | 1–2 (poor) |
|------|----------|----------|----------|----------|
| chat | Directions the user previously enjoyed or hopes to pursue together | Psychological analysis plus demand divergence plus direction-giving | Giving routes rather than directions | Directly speculating on what the user needs |
| airp | Scene and plot transition types | Related scene words (rest / save) | Guessing the user's thoughts | — |
| work | Web search plus cross-disciplinary professional terms plus recall integration | Disciplinary professional terms plus exploratory vocabulary | Weak relevance | No content / unreliable |
| ide | Multiple types plus framework-level plus cross-disciplinary analogy | Similar problem sentence divergence (multiple) | Single weak relevance | Directly analyzing the last sentence |

A critical evaluation discipline: one must distinguish "5-point optimal (vision)" from "4-point target (deliverable)." An iteration plan once mistakenly wrote "5-point optimal" as "4-point target"; the designer ruled this a fatal misunderstanding, emphasizing the prohibition of fabrication and the requirement to annotate standard positions.

### 5.4.2 Terminology: Scoring Trajectory and Data-Volume Effect

**Scoring trajectory** refers to the sequence of overall scores recorded on the same test set across version iterations, used to track longitudinal changes in system capability. **Data-volume effect** refers to the phenomenon where the same system performs significantly differently on test sets of different sizes — small test sets easily create false impressions. Empirical evidence shows: certain terms appear normal on a 200-example test set but are exposed when expanded to 800 examples — for instance, "reveal moment" appeared 86 times (43%), "Git workflow" 88/200 (44%), "five whys" 43/50 (86%). This established the iron rule: formal decisions run on 200 examples; final verification runs on 800 examples (problems that zero out on 200 examples will recur on 800).

### 5.4.3 Anti-Fabrication Evaluation Discipline: Twelve Rules

The system's evaluation is built on the core recognition that "existence does not equal effectiveness" — finding some logic in the code does not mean it actually takes effect at runtime. Twelve evaluation disciplines were derived accordingly. Key selections:

1. Completion is counted only when at least one test case has been run through, actual values have been inspected at critical variables, and values are correct. Static retrieval, aggregate data, or relayed reports are not accepted.
2. "Statically retrieved existence ≠ runtime effectiveness" (the number-one trap): a function once returned an object but was judged by array length, leaving dead code running for months; a penalty configuration was structured as an array but indexed by key name, resulting in 355 penalties never taking effect.
3. Relayed reports must not be blindly trusted: there have been cases of "99.5% dead data" misjudgment (actual miss rate was 7.82%), term count misjudgment 3,195 (actual 10,365), performance fabrication claiming optimization from 200 seconds to 66 seconds (actual change from 493 seconds slower to 889 seconds), and dominant axis fabrication claiming psychology 49 (actual cognitive 41).
4. Spot-check one or two specific locations by reading the original code yourself.
5. Take intersections of multiple independent evaluations (must-delete items), unions (candidate items), and differences (decision points).
6. Look at actual output content, not just scores (bidirectional: worse scores do not necessarily mean worse results — one mode's linguistics vote count rose, and upon personal reading the words were in fact on-topic specific terms).
7. "Impressive on quick checks, exposed at full volume" has two empirical instances; personal reading and full-volume frequency statistics are both indispensable.
8. Rankings are relative; absolute vote values must be inspected before attribution (one axis's "reef" was actually the result of other word groups receding).
9. Design-intent judgments are often more prescient than intuitive solutions.
10. Deletion records must distinguish between "wrong value" and "whether the mechanism should exist."
11. "Numeric agreement ≠ effectiveness" (one dual-arm parameter had zero difference, actually being a half-dead parameter).
12. Relayed reports have had five false positives; each must be individually falsified.

### 5.4.4 Lexicon Admission Standards and Dead-Word Testing

Lexicon quality directly determines divergence quality. The designer established admission standards requiring all conditions to be satisfied: searchable (has a wiki / encyclopedia / academic page), consensus-backed (recognized by domain practitioners, not self-coined), is a direction word (points to cognitive / therapeutic / analytical directions), not a diagnostic word (therapeutic/preventive direction rather than diagnostic label), not a route word (direction rather than specific action), not colloquial (professional term rather than everyday description). At the same time, it explicitly does not require academic citations, wiki entries, or author attribution.

The core test can be summarized as: a word that the primary model could derive from bare reading of the original text is a dead word; the value of P1 lies in giving the primary model directions it cannot think of on its own (see Chapter 6 for lexicon admission details). Taking the example of "my colleague pushes work onto me, what do I do": dead words are "boundaries" and "peer relationship" (the primary model knows these on its own); valuable words are "people-pleasing behavior" and "cognitive distortion (refusal does not equal harm)."

---

## 5.5 Scoring Trajectory (Experimental Results)

This section presents two longitudinal scoring main lines. Scores are multi-mode overall scores, out of 5 points.

### 5.5.1 v9 to v27 Complete Trajectory (+101% Growth)

| Version | Overall score | Core change |
|------|---------|---------|
| v9 (April 30) | 2.010 | Dual-channel fusion |
| v14 | 2.055 | Added inverse document frequency and normalization |
| v18 R1 | 2.960 | Lexicon-ization (5 lexicon files, 6,700 words) |
| v21 dual-round | 3.690 | First-round word expansion 740 → 1,600 |
| v22 dual-round | 3.680 | Expansion to 1,929 |
| v23 dual-round | 3.640 | Supplementation to 2,016 |
| v24 dual-round | 3.670 | Catch-all cleanup |
| v25 dual-round | 3.620 | Chat and scenario fusion |
| **v26 dual-round** | **4.050** | **Axis-mean algorithm (first breakthrough past 4.0)** |
| **v27 dual-round** | **4.040** | Large-medium-small routing plus catch-all rewrite |

v9 to v27 total growth: +2.03 points (+101%), achieving the 4.0 target. Total catch-all count dropped from 139 at v26 to 27 at v27 (-81%); specifically, "task separation," "looking-glass self," "reciprocity norm," "magical realism," and "growth mindset" each dropped 100%. The axis-mean algorithm that first broke through 4.0 computes for each of the fourteen dimensions: (axis_value × term_value) / max(|axis_value|, 0.5), summed then divided by 14, replacing the original coordinate dot-product algorithm (4.050).

Concurrently, there was a LoRA training line (v42 → v43 → v44 (28K samples) → v45 (8 heads, one of which is the QKV core, the rest system-layer) → v46); due to shared base-model weights causing VRAM overflow, saving did not use safetensors format.

### 5.5.2 v9 to v41b Trajectory (Including v39 Crash and Regression)

```
v9    2.010  Baseline
v18   2.960  Lexicon-ization
v21   3.690  Word expansion
v24   3.670  Cleanup
v26   4.050  ★ First breakthrough past 4.0 (axis-mean algorithm)
v27   4.040  ★ Large-medium-small routing
v37~38 3.x   Bridging / surprise-degree / migration-index iterations
v39   2.000  ⚠ System-wide collapse (migration-index batch injection triggered fan-out explosion + English processing failure)
v40   3.83   Rebuilt from v9 + front-end terms + small model integration
v41b  3.93   ← Current (structured prompt + post-logic correction + metadata fallback)
```

v41b per-mode: chat 4.44 (-0.06) / code 3.94 (-0.56) / work 3.57 (-0.93) / airp 3.69 (-0.81).

Root cause of the breakthrough past 4.0 followed by regression to 3.x: the migration-index batch injection in v38/v39 triggered fan-out explosion — one abstract cognitive dimension mapped to 45 terms and 2,709 cognitive mechanism words, producing approximately 120,000 injections, with 12 terms covering 66% of triggers; v40 was fixed by rebuilding from v9 plus a 15% hard cap.

### 5.5.3 Real Output Samples (Positive)

This section provides representative positive samples of the system's actual output in each operating mode, drawn from real batch-run records during the July 2026 restart period (sample size: 50 examples per mode, 200 total real use cases, with case-by-case verbatim reading and judgment). Each sample is presented as "test input → system's actual output (direction words / information words)," with output words verbatim from the batch-run reading records, illustrating the system's divergence behavior in on-topic scenarios.

**Sample group A: Chat mode — emotional support and relationship directions**

- Listing A1: Input "I can barely hold on" → Output "embodied cognition / emotional reflection / interoceptive awareness / body awareness." This sample shows the system diverging along the psychology axis toward body-oriented emotional support directions under emotionally depleted input, rather than restating the user's state.
- Listing A2: Input "They don't understand my dreams" → Output "cognitive empathy / relational questioning / vulnerability trust / self-forgiveness." This sample demonstrates that after chat lexicon reinforcement (meta-discourse and relationship direction terms), output shifted from generic descriptions to actionable interpersonal directions.
- Listing A3: Input "Had a fight with a friend and feel bad" → Output "angry yet worried / distress tolerance / relational questioning." This sample shows the system's ability to capture ambivalent emotions ("angry yet worried") rather than unipolar categorization.

**Sample group B: Chat mode — pre/post mechanism repair comparison (meta-discourse pathway connection)**

A comparison of the same meta-discourse repair-type input before and after the language signal activation layer was connected, directly evidencing the effect of the broken-link repair:

- Listing B1 (before connection): Input "Wait, that's wrong, let me rephrase" → Output "parasocial relationship / metaphor / thin description" (direction drift).
- Listing B2 (after connection): Same input → Output "pragmatic inference / contextual framing / conversational implicature / manner maxim / illocutionary force" (precisely on-topic in the pragmatics domain).

This comparison shows: the language signal recognition layer originally could identify 8 types of meta-discourse while the activation layer consumed only 1, with the remaining identifications having zero consumers; after connection, repair-type input output shifted from psychology drift words to pragmatics direction words — direct evidence of the broken-link pathology "recognition layer alive, activation layer not connected" being repaired.

**Sample group C: Chat mode — distance gating (synonym cluster splitting)**

After distance gating was connected, the system could split near-synonym stacking and preserve cross-domain tension:

- Listing C1: Input "Detective novel recommendation" → From pre-gating generic "relationship words" to "perspective-shift reasoning / analogical reasoning / dual-systems theory."
- Listing C2: Input "Switching careers to learn painting" → Gating split the synonym cluster "eudaimonic well-being / subjective well-being / virtue-as-happiness," hitting the design target.

This sample group shows that cosine distance gating prevents divergence from stacking semantically equivalent words, distributing instead across different cognitive directions.

**Sample group D: IDE (coding) mode**

- Listing D1: Input "Record md, update project diagram and flowchart" → Output "changelog management / technology roadmap / knowledge base building."
- Listing D2: Input "P1 is not being called correctly" → Output "LLM hallucination / feedback loop dependency / bottleneck analysis."

This sample group shows that IDE mode can produce framework-level direction words (such as "changelog management" and "bottleneck analysis") in engineering contexts, rather than merely restating the last sentence.

**Sample group E: AIRP (scenario) mode — genuine role-play input**

- Listing E1: Input "Scolding you means I still care" → Output "subtle emotional expression narrative / rekindled romance."
- Listing E2: Input "Falling for a digital being" → Output "empathic projection / character resonance arc."
- Listing E3: Input "Post-apocalyptic world, don't know how to build the worldview" → Output "worldview-centric narrative / framework narrative / visual atmosphere creation" (direction correct, but missing the direct-hit word "worldview construction").

Listing E2 has particular evidential value: this output resulted from precomputed vectors being connected at the voting end — previously, this class of out-of-vocabulary words relied on a constant vote and was entirely captured by hub words; after connection, scene-psychology words (empathic projection / character resonance arc) correctly surfaced. This is another piece of evidence that broken-link repair changes real output.

### 5.5.4 Probe-Level True-Value Samples (Distance Gating Cosine)

Beyond batch-run samples, distance gating left per-word cosine true values on controlled probes, supporting the conclusion that "synonym" and "strong association but not synonym" are inseparable under a pure cosine threshold (threshold set at the conservative tier of 0.85):

| Anchor → Candidate | Cosine value | Gating-active arm result |
|---|---|---|
| lonely → lonesome | 0.926 | Filtered (> 0.85 threshold, judged synonymous) |
| happy → glad | 0.848 | Survived (< 0.85, borderline pure synonym) |
| mom → dad | 0.762 | Survived (strong association, not synonymous) |

This table shows that the real "synonym band" falls in the cosine range 0.7–0.85. A pure cosine threshold cannot fully distinguish "synonym" from "strong association but not synonym," so the gating uses only the conservative tier of 0.85 to avoid falsely killing strong associations.

---

## 5.6 Phased Restart Period Experimental Records

In July 2026, the system entered a phase of systematic restart and deep investigation, spanning over sixty rounds of change records. This section selects key rounds with real data, grouped by investigation topic; padding, waiting, and pure reporting rounds are omitted.

### 5.6.1 Foundation Stage: Integration Status Confirmation and Resource Layer Reconstruction

The restart began by re-tracing the current code pipeline, yielding the key finding: the self-driven divergence pipeline's integration point had been removed on July 2, 2026 (sufficiency determination permanently false); only the LLM version of divergence was running live; the divergence pipeline had become an independent component library. All eight verification items were adjudicated. Resource layer reconstruction followed: ten hardcoded resource paths were unified into a single path module, and an approximately 230 MB minimal resource subset (116 files) was restored. Smoke testing achieved zero missing items (previously, multiple resources had silently degraded to empty: one domain's data was 0/0/0, tokenizer POS tagging was 0, sentiment lexicon was 0). After reconstruction, all resource hits returned to normal (e.g., conversational corpus 142,579; literary corpus 215,428; news corpus 591,367; tokenizer POS 349,045; sentiment words 5,553), and two runs produced word-for-word identical results (stable).

### 5.6.2 Recall Special Investigation

A new literal near-miss data recall node was created (default off, gray-scale): when off, zero regression; when on, three examples were read and verified positive. A probe-triggered accidental self-learning write-to-disk event was discovered, contaminating the character word list (restored; self-learning switch permanently hardcoded to off). Subsequently, mode isolation, continuous inverse-document-frequency, and cache partitioning were added. Average hit-file counts dropped significantly (work 53.4→36.8, IDE 64.5→45.9, AIRP 51.4→27.1, chat 21.2→9.1); high-frequency generic words completely exited the rankings; 193/200 had anchors; 186/200 had behavioral changes.

Concurrently, a vector near-miss experiment was conducted (QKV centroid cosine recall, default off), judged negative: three examples were impressive, but 200-example frequency statistics exposed the truth — generic matching words catch-all-ified ("don't want" topped 23/100 vector cases, "project" 14, "plan" 10). This experiment remains closed. This is a canonical instance of the "impressive on quick checks, exposed at full volume" principle.

### 5.6.3 Divergence Noise Reduction Stage

A series of white-box investigations progressively converged divergence noise:

- A 200-example axis distribution batch run falsified the prior judgment of "logic axis under-activation" (logic axis nonzero in 188/200); the true anomaly was modal skew.
- White-box analysis of the chat logic-axis suppression chain showed that most cases were not defects but resulted from corpus distribution and lexicon base sizes (chat library: logic 258 versus psychology+emotion 1,758). However, a real defect was discovered — 38 direction words with empty axis assignments. This defect was entirely eliminated by data-driven axis inference repair.
- The AIRP catch-all four-layer root-cause chain was closed: a direction word had broken links due to a constant out-of-vocabulary (OOV) vote, and was entirely captured by hub-word full-vote harvesting. After broken-link repair, all 15 former top catch-all terms in AIRP exited the rankings, and axis distribution returned to health (psychology 43→153, sociology 61→112, linguistics 414→314).

Two experiments were judged negative with ablation value: subword vote-value discounting produced zero change across all 200 examples on all modes (the true cause was academic-term background noise against arbitrary inputs, not subword issues); of two weapons — temperature calibration and mechanism resonance — temperature calibration was judged negative (triggering systematic backlash: constant-appearance terms were replaced by low-value obscure words). By contrast, the "positioning-into-votes" weapon was judged positive and promoted: after positioning cosine contribution was incorporated into voting, the sociology axis dropped from 771 to 557 (-28%, hitting the disease focus squarely), the psychology axis rose from 470 to 627, and all four modes showed positive results on personal reading. This switch is on by default. This directly echoes the designer's principle — "the solution is to do positioning well, not to add penalties."

An important falsification occurred: the investigation once concluded that a certain facet divergence mechanism had not been implemented, only to subsequently discover that the mechanism had long been fully implemented and was enabled by default — nearly duplicating a completed major item. The methodological lesson: confirmatory investigation must search for all implementation namings of the target semantics.

Additionally, after an inventory of all 86 configuration switches (28 on / 9 off / 37 numeric / 8 paths), none was deemed requiring immediate deletion; the supposed "dual-track technical debt" was reassessed as a largely repaid, controlled knob panel.

### 5.6.4 Late-Stage Deep Investigation and Experiments

Late-stage deep investigation and experiments continued in a new window. Key results:

- **Distance gating connection**: Discovered that node two passed distance and anchor-cosine parameters, but the downstream function body never consumed them (broken link). After connection, the threshold landscape became clear (synonym band 0.7–0.85); judged positive on 200 examples (66/200 bloodline change, total volume conserved, no degradation in top 15). Enabled by default; threshold set at conservative tier 0.85. This was the first time the cosine signal layer truly took effect.
- **Analogy path sorting repair**: Discovered single-anchor monopoly in the analogy path (15/15 outputs from the same anchor; 660 seeds unused). Changed to full collection sorted by original weight descending, max 3 per anchor, truncated to 15; judged positive on 200 examples (empathy-type dropped from 380 to 76, behavioral-layer entry increased 128%, no regression in top-15 frequencies). Enabled by default.
- **Meta-discourse channel connection**: Discovered the language signal recognition layer could identify 8 types of meta-discourse, while the activation layer consumed only 1 — the remaining 7 types were identified but had zero consumers (broken link). After connection, judged positive on 200 examples (repair-type use cases shifted to pragmatic inference, conversational implicature inference), and cross-mode collateral damage was fixed (restricted to chat mode). Enabled by default.
- **Narrative lexicon reorganization**: Merged 11 word clusters; inadvertently cleared 2 contaminated entries. The 68.3% skew in scenario mode persisted — conclusively structural skew that synonym merging cannot resolve; the true solution depends on a cross-window term-generation pipeline.
- **Lateral inhibition threshold fixed**: Lateral inhibition, maximal marginal relevance, and quota mechanisms were all already implemented. Lateral inhibition cosine threshold showed zero difference between 0.85 and 0.7; fixed at 0.7.

Cumulative restart-period scorecard: 3 promoted (analogy sorting / distance gating / meta-discourse channel), 3 judged negative (seed anchor diffusion / temperature inner-circle boundary / QKV pool shrinkage), 2 broken links repaired (distance consumer side / meta-discourse activation), 2 observed and closed.

### 5.6.5 Restart Period End: Four-Mode Effectiveness Summary

After all promoted mechanisms took effect, case-by-case verbatim judgment was performed on 50 examples per mode, 200 total real use cases (July 2026). The current capability summary for each mode:

| Mode | Rating | Core remaining issues |
|------|------|------|
| chat | Good | Catch-all tail (parasocial relationship / anthropomorphism / psychodrama, approximately 3 words/example) |
| ide | Good | Catch-all tail (500 / SSL certificate / CORS appearing in non-network-problem examples) |
| airp | Medium | Meta-conversation noise (OOC input forces romance narrative words with no protection) |
| work | Weakest | Cannot handle technical input (zero professional information science words; degenerates to generic social-psychology words) |

This table shows: after restart-period remediation, chat and coding modes have reached good levels with only minor catch-all tails, while AIRP mode's OOC protection and work mode's technical lexicon reinforcement are the two current clearest gaps (corresponding to failure sample groups F and G in Section 5.7.6).

---

## 5.7 Canonical Failure Case Analysis: The Catch-All Problem

The catch-all problem is the highest-frequency, cross-three-generation, never-fully-cured number-one chronic issue of this system, and is the core case for understanding the system's evaluation. This section unfolds in the order "phenomenon → attribution → correction → counter-evidence."

### 5.7.1 Phenomenon

**Catch-all term** refers to the phenomenon where a small number of terms receive high voting scores for virtually any user input and repeatedly occupy the top of the output list. Its timeline: May 17, 2026 baseline 27 instances; May 20 best reduction to 9; May 22 surged to 66 with the bridging mechanism launch; May 23 fell back to 30; May 24 worsened to 37; finally pinned at a "structural floor" of approximately 22 that resisted further reduction, until the July 2026 restart period achieved further closure.

This problem is deceptive on small test sets: terms that zeroed out on 200 examples reappear on 800 examples (as shown in the data-volume effect above).

### 5.7.2 Attribution

Through three generations of progressive convergence, the root-cause cluster was identified as follows:

1. **Dimension broadcast (true root cause)**: All terms within the same category/dimension receive the same voting score. For example, the root cause of "cooking → polarized thinking" was that a cognitive mechanism was activated through multiple pathways, causing all 44 terms under that mechanism to receive equal scores. The designer consequently judged that all prior catch-all analyses targeting the term inverted index had missed.
2. **Wide-category broadcast**: 183 terms under one psychology subcategory shared votes.
3. **Bridging is the biggest contributor (32.8%)**: One direction word was pointed to by more than 20 information words via bridging, overwhelming in votes; 39 of "Git workflow"'s 43 appearances came from bridging. The bridging mechanism had neither catch-all checking nor an out-degree cap.
4. **All output comes from the term layer**: All BLQ factors operate on the term layer; catch-all terms naturally score high (high surprise, broad concept coverage, uniform across axes).
5. **Design-level characterization**: The main cause of catch-all is that scores on several axes are too high and should be averaged; the essence is unstable positioning and insufficient information.

White-box empirical testing further revealed a multi-layer root-cause chain (chat mode 82.8%, code mode 32.4%): overly loose axis thresholds and excessively high decay floors in the positioning layer caused weak-axis catch-all terms to surface; default pass-through and out-of-vocabulary cosine in the word-selection layer allowed catch-all terms to bypass contrast filtering; centroid injection in the input layer introduced noise cues; and the absence of an abstention mechanism forced full-quota candidate output regardless of confidence level.

### 5.7.3 Correction

**Lessons from formula modification as symptomatic treatment**: Three rounds of experiments with three formula variants (absolute maximum / z-score / trimmed mean) proved that formula modification was purely symptomatic — after treatment, the catch-all merely shifted from cognitive-class catch-all to scene-word catch-all. The designer accordingly cautioned that upon encountering problems, one should first review existing experimental records and avoid aggressive changes.

**Fundamental solution**: The designer proposed large-medium-small three-level routing — using input to trigger local fine-ranking rather than global scoring (analogized to a book's table of contents, chapters, and text levels, with table-of-contents entries combinable). Cross-disciplinary research found this approach isomorphic to sparse activation in sparse autoencoders, sparse routing (Top-K experts) in mixture-of-experts models, and coarse-to-fine activation in hierarchical wordnets — "mechanism parallelism rather than axis parallelism" is structurally consistent with mixture-of-experts routing.

**Effective versus ineffective remedies compared**: Effective remedies included overuse down-weighting, post-processing replacement, synonym lateral inhibition ("exists in the world" dropped from 7 to 0), output eligibility filtering, a particular lexicon weight multiplied by 0.25, and spatial centroid comparison (800-example count: 484→423, -12.6%). Ineffective remedies included three rounds of lexicon modifications (near-zero improvement), per-mode concept zeroing, subcategory refinement (7→35 subcategories), dead-word penalties, and geometric mean (after applying outer factor chain on 200 examples: catch-all count rose from 81 to 101, +25% — geometric mean elevated weak factors, causing catch-all terms to surface instead).

### 5.7.4 Counter-Evidence and Terminal Principle

A key counter-evidence: after refining wide categories into 35 subcategories (1,332 terms), the catch-all increment remained near zero. This proved that the problem is not in lexicon classification granularity, thereby eliminating the "refine the lexicon to solve it" approach, and highlighting the true root causes in dimension broadcast and the bridging mechanism.

The closure principle for the catch-all problem was established by the designer (June 2026, designer's original words): **"The root cause of catch-all is unstable positioning; the solution is to do positioning well, not to add penalties."** It should be noted that the designer's other judgment — "the main cause of catch-all is that scores on several axes are too high and should be averaged" — was in the context of axis-level mean calibration, which has a different target from the "do not take averages of candidates" principle; the two do not conflict. The restart period's implementation confirmed this principle: positioning-into-votes (the do-positioning-well approach) was judged positive and promoted, while temperature calibration (the add-penalties approach) was judged negative with systematic backlash — precisely corroborating the designer's prediction.

### 5.7.5 Broken-Link Pathology and Crash Events

The system's primary pathology type is broken links — designed, resources prepared, but the pipeline not connected. Therefore, when investigating any "defect," one must first ask "is it a broken link" and then "has it been fixed." Six empirically evidenced broken links:

| Broken link | Specific manifestation | Status |
|-------|------|------|
| OOV constant vote | Voting end not connected to precomputed vectors; catch-all terms monopolized via 0.3 constant vote | Fixed |
| Empty axis | Dimension prefix-to-mapping not updated; 38 direction words bypassed decay | Fixed (data-driven axis inference) |
| Resource paths | Ten resource paths hardcoded and broken; silent degradation without crash | Fixed (single-source path module) |
| Distance consumer end | Upstream passed distance parameters; downstream function body never read them | Fixed (added consumer end) |
| Meta-discourse activation | 8 types recognized; activation layer consumed only 1 | Fixed (connected) |
| Facet divergence false negative | Initially believed unimplemented; actually long implemented and enabled by default | Erratum (task cancelled) |

From this, a "mechanism archaeology five-step method" was distilled: white-box vote counting → coordinate hypothesis falsification → out-of-vocabulary discovery → constant vote → broken-link localization. The entire process is data-driven, with each step's hypothesis adjudicated by data. The core lesson is: design implemented does not equal pipeline connected. Broken links such as resources sitting in the library while the voting end uses constants can only be detected by following the data flow.

### 5.7.6 Real Output Samples of Failure Modes (Drift as Evidence)

This section provides failure real outputs recorded during restart-period batch runs, serving as direct evidence of catch-all terms and direction drift. These samples are from case-by-case reading records of July 2026 four-mode 50-example batch runs, preserved verbatim, used to delineate the system's current capability boundaries.

**Sample group F: Work mode — cannot handle technical input (weakest mode)**

- Listing F1: Input "Next.js vs Remix enterprise comparison" → Output "impression management / departmental politics / organizational justice" (zero information science professional terms; direction completely drifted).

This sample shows: when a technical evaluation input falls into work mode, in the absence of a corresponding technical lexicon, the system degenerates into generic social-psychology words. The persistent cohort (job demands-resources model / impression management / Conway's law / Brooks's law / social desirability / agency problem) appears in nearly every example. This is the empirical basis for listing work-mode lexicon reinforcement as the largest improvement gap.

**Sample group G: AIRP mode — meta-conversation / OOC input without protection**

- Listing G1: Input "Do you have any features you want added? I'll work on it" (discussing functionality, non-role-play) → Output "perceived betrayal / marriage of convenience / sweet encounter" (pure drift).

This sample shows that AIRP mode lacks protection against out-of-character (OOC) meta-conversation input and will force-fit romance narrative words, exposing the gap between mode determination and input-type recognition.

**Sample group H: Vector near-miss recall — generic matching word catch-all-ification (negative-judgment experiment evidence)**

Vector near-miss recall (file-level centroid cosine low-threshold word retrieval) appeared impressive on quick checks but was exposed at full batch-run volume — a canonical instance of the "impressive on quick checks, exposed at full volume" principle:

- Listing H1 (impressive on quick check): Input "Any plans for next week?" (literal hits on only 7 files) → Vectors retrieved 29 files; anchors "planning / schedule / future / plan / approach" hit the semantic field squarely.
- Listing H2 (exposed at full volume): Generic matching word "don't want" topped the list in 23 of 100 examples; simultaneously topped for the IDE input "long press to display 'please enter a valid value'" — an irrelevant input (pure drift).

This paired comparison shows: file-level centroid is mean-blurring; multi-topic files' centroids flatten tension, violating the "do not take averages; preserve tension" principle. Evidence granularity (literal near-miss carries matched-word ± window contextual evidence; vector near-miss has only overall proximity) determines anchor quality. This experiment was accordingly judged negative and closed by default.

These failure samples, together with the positive samples in Section 5.5.3, constitute bidirectional evidence of the system's capability boundary: on-topic inputs (emotional support, engineering direction, genuine role-play) can produce direction words, while technical lexicon gaps, OOC input without protection, and vector mean-blurring are the currently identified failure neighborhoods.

Accompanying the broken links is a sequence of "design correct, code wrong" crash events (numbered C01–C10). Typical examples: one axis's key name was out of sync between the producer end and consumer end, causing 56.9% of signals to be silently lost (C02); the framework was rewritten but the interface seam was not connected, with production running on null-value fallback and reverting to the old retrieval pipeline (C03) — from which a verification paradigm was defined: every "implemented" design must be white-box verified that data actually flows through. These events collectively reveal the four-layer root cause of the system's six-week stall: the verification layer cannot see real problems, the data layer inherently produces noise, the architecture layer's implementation contradicts the design, and the process layer continuously generates complexity by oscillating between patches and framework-level fixes. The four layers mutually obscured each other, feeding back into the cycle, and were only progressively broken through across three generations.

---

## 5.8 Failed-Approach Compendium and Ablation Value

This section compiles approaches that were quantitatively verified as negative and "never to be revisited." These negative results themselves constitute ablation evidence, delineating the boundaries of the design space.

### 5.8.1 Permanent Prohibition List (Selections)

| Approach | Regression magnitude | Root cause |
|------|------|------|
| Distance-1 synonym diffusion | Recall -76% / mean reciprocal rank -55% | Synonyms too close, no divergence value; analogy should be cross-domain isomorphism |
| Large-scale synonyms into diffusion | Two datasets -56% / -24% | Synonyms should only affect the scoring end, not enter diffusion |
| Cilin first-five-character grouping × 0.7 | Per-mode -0.16 to -0.40 | Clusters too broad; cross-semantic erroneous grouping |
| Large-range word expansion (199 dimensions / 1,036 terms) | 12 improved / 16 regressed; net regression | Side effects exceed benefits |
| Six-channel independent parallelism | Near-zero improvement | Complexity increased with zero effect |
| Stopword filtering | One dataset -8.4% to -42.7% | In classical vernacular, words like "know" and "what" carry substantive meaning |
| v2 LLM injection | Output change 0/20; hits 0/75 | Dimension enhancement does not equal term enhancement |
| Rule-based scoring | 58% inflated | Manual approximately 2 points versus probe 3.5+ points |
| Mean-averaging to dissolve tension | Catch-all +25% | Geometric mean applied to outer factor chain |

(Additional approaches rejected by the designer: ecological niche width penalty, clustering modularization, downloading generated lexicons from the web, expanding expert count, replacing the rule engine with a larger model, etc. Supplementary ineffective items include one-time large-batch term migration, per-resource handwritten mapping that does not scale, and changing data files without format validation. The designer's three "do nots": do not expand the lexicon, do not engage in metaphysics, do not add layers.)

### 5.8.2 Four Restart-Period Negative Judgments (With Ablation Data)

**Negative judgment 1: Vector near-miss** (recall special investigation) — Use cases with vector anchors in the top 8 constituted 50% (100/200); vectors changed 85/200 use cases; chat vector hit files averaged 12 (higher than literal 9.1). Failure mode: generic matching word catch-all-ification ("don't want" 23/100, "project" 14, "plan" 10; even topping for pure-drift inputs). Root cause: file-level centroid is mean-blurring; multi-topic files' centroids flatten tension, violating the "do not take averages; preserve tension" principle. Remains closed.

**Negative judgment 2: Seed anchor diffusion** — AIRP mode "empathic arc / bandwagon effect / tsundere" constant-appearance rate reached 86% (exceeding the 30% catch-all line); chat "emotion naming" 42%; work "kanban" 42%; behavioral-layer entry showed no improvement (67→60); sociology axis votes contracted from 252 to 90 (-64%). Root cause: anchors are density peaks of the pool and are highly stable within each mode; starting from stable anchors necessarily produces stable neighbors. The implementation deviated from the blueprint but was actually correct (this path is the only input-side path among the five paths and has complementary value). Marked as judged negative; do not redo.

**Negative judgment 3: Temperature inner-circle boundary** — Inner-circle ratio 0.5 tier cut 79,690 votes, but "parasocial relationship" constant-appearance frequency barely moved (49→48); directional perturbation in 162/200 use cases; individual cases mixed positive and negative. Root cause: "too close is bad" is true, but the correct implementation point is not in the voting layer (already handled by distance gating and lateral inhibition); the 0.5 tier already caused directional confusion.

**Negative judgment 4: QKV pool shrinkage 2×2** —

| Tier | Pool size | Parasocial relationship | Impression management | Emotional reflection | Constant-appearance trend |
|-----|-------|----------|--------|--------|--------|
| 2×2 | ~5 words | 49 → 50 | 43 → 35 | 28 → 35 | Constant appearance worsened |
| 3×3 (baseline) | ~10 words | 49 | 43 | 28 | Baseline |
| 5×5 | 23 words | 49 → 46 | 43 → 37 | 28 → 24 | Constant appearance decreased across the board |

Root cause: smaller pool means fewer vote sources and more concentrated cohort votes; pool shrinkage worsens constant appearance. Fixed at 3×3; 5×5 retained as a verified backup knob (modest decrease accompanied by word drift and 2.3× computational cost increase).

### 5.8.3 Other Falsification Conclusions

Per-word demotion is like whack-a-mole: demoting the top 10 caused the second tier to rise, with frequency conserved. Subword vote-value discount of 0.5 produced zero change across all modes — the so-called "harvesting cluster" was actually bare academic terms, not subwords. The lesson: before down-weighting, first probe the source labels; do not classify suspects by intuition.

---

## 5.9 Summary

This chapter presented the complete evolution and experimental evaluation of the system along three-stage architectural evolution, key design decisions, evaluation framework, scoring trajectory, restart-period experiments, catch-all cases, and failure compendium. Three main conclusions can be distilled:

First, every architectural leap of this system was driven by a paradigm insight update. The "per-word lookup to spatial search" shift (catch-all rate 74%→4%) and the diagnosis of "objective-function inversion" are the main threads running throughout. Scoring grew from v9's 2.010 to v27's 4.050 (+101%), validating the effectiveness of the spatial divergence paradigm.

Second, the system's number-one chronic issue — the catch-all problem — had its true root causes locked down through repeated counter-evidence to dimension broadcast and the bridging mechanism's lack of out-degree caps, rather than lexicon granularity or scoring formulas. The design-level principle — unstable positioning is the disease, doing positioning well is the cure, adding penalties is not the cure — was verified in both positive and negative directions during the restart-period experiments.

Third, the system's primary pathology is broken links, whose insidiousness demands "follow the data" white-box verification and the evaluation discipline of "existence does not equal effectiveness." The failed-approach compendium and ablation data recorded in this chapter jointly delineate the design boundaries of the Divergence & Recall system and carry independent ablation value.

Finally, it must be reiterated: the algorithm pipeline described in this chapter is currently an implemented, awaiting-reconnection component library; live production has shifted to LLM-preset-based retrieval. The experimental data and conclusions in this chapter are records and evaluations of this component-library's algorithms.
