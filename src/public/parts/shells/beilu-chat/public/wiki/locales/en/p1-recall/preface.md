# P1 Self-Driven Divergence & Recall System: Design, Algorithms, and Experiments (Compendium)

## Abstract

This compendium systematically describes the P1 self-driven subsystem within the always-accompany project -- an **externalized chain of divergent thinking**. Its starting point is a fundamental judgment held by the designer: large language models (LLMs) are structurally "contraction machines" whose attention mechanisms and generation processes inherently tend toward convergence, and which lack the capacity for active divergence; therefore, divergence must be implemented as a node external to the model. P1 constructs, outside the model, a processing pipeline that does not depend on LLMs: anchored by memory recall and conversational context (contraction), it diverges in parallel through an association network and six disciplinary axes (psychological, informational, social, logical, linguistic, cognitive), produces direction words via spatial additive voting and many-to-one contraction in a shared candidate pool (re-contraction), and ultimately provides a directional framework for the model's generation through prompt injection.

The compendium now has seven chapters. Chapters 1–6 preserve P1's design ideas, older node system, memory design, and historical experiments. Chapter 7 records the current production contract: Node0–4, up to five recent user messages plus Data, four-dimensional isolation, white-box evidence, lazy resource loading, and bounded caches. Read Chapter 7 first when you need to know how the current system actually runs; historical runtime descriptions do not override current source.

## Table of Contents

| Ch. | File | Content |
|---|---|---|
| Current | [Chapter 7: Current Production Contract](ch7-current-runtime.md) | Current Node0–4 route / input contract / four-dimensional isolation / time and Top / caches and white-box evidence / measured boundary |
| 1 | [Chapter 1: Design Philosophy and Conceptual Framework](ch1-concepts.md) | Design motivation: three core judgments / Sources of design thinking / Three-stage mechanism overview / Core conceptual framework / Terminology conventions |
| 2 | [Chapter 2: System Architecture and Processing Flow](ch2-architecture.md) | Five-step standard processing chain overview / Overall architecture (node graph, three routes, U-shaped injection) / Per-node specification / Architectural evolution |
| 3 | [Chapter 3: Algorithm Design and Formal Descriptions](ch3-algorithms.md) | Original algorithms itemized (motivation, formulas, design rationale, related-work comparison) / Complete scoring framework specification / Ablation studies and failed approaches / Related work summary table |
| 4 | [Chapter 4: Memory System](ch4-memory.md) | Design foundations (human memory models) / Data layer / Memory processing pipeline / Dual-track recall / Injection mechanisms / Empirical results |
| 5 | [Chapter 5: System Evolution and Experimental Evaluation](ch5-evolution.md) | Three-phase evolutionary history / Design-decision timeline / Evaluation framework and metrics / Scoring trajectories / Representative failure case analyses / Failed-approach compendium |
| 6 | [Chapter 6: Resource System and Appendices](ch6-resources.md) | Linguistic resource system / Lexicon system / Engineering conventions and constraints / Terminology glossary / System status and roadmap |

## Reading Conventions (Uniform Across All Chapters)

1. **Value-source grading.** All numerical values in this text are annotated with their source level: **experimentally calibrated fixed values** (locked by auditable experiments) or **initial defaults (not systematically tuned)**. Shape-level formulas (structures) serve as specification descriptions; specific weights, coefficients, and thresholds are subject to the implementation.
2. **Runtime-status declaration.** Self-driven P1 is connected to the current host pipeline through local Node0–4 recall. AI P1 remains as a mutually exclusive option, and both may be disabled; two owners cannot run together. “Component status” or “AI P1 active” statements in Chapters 1–6 are July 2026 historical snapshots. [Chapter 7](ch7-current-runtime.md) and current source define the live route, input contract, and measured boundary.
3. **Citations.** Except for a very small number of passages annotated as "designer's original words," all content in this book is a normative paraphrase of design intent and implementation.
4. **Related-work grading.** Chapter 3 provides a prior-art comparison for each algorithm, graded as follows: A = mechanism highly similar and published before this system's design (possible convergent invention); B = partially similar (overlapping components, different overall mechanism); C = only conceptually similar terminology; D = no similar published work found. The audit conclusion is A = 0.
5. **Terminology.** Each chapter defines terms at their first occurrence; the full glossary appears in Appendix A of Chapter 6.
