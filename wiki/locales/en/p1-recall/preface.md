# P1 Self-Driven Divergence & Recall System: Design, Algorithms, and Experiments (Compendium)

## Abstract

This compendium systematically describes the P1 self-driven subsystem within the always-accompany project -- an **externalized chain of divergent thinking**. Its starting point is a fundamental judgment held by the designer: large language models (LLMs) are structurally "contraction machines" whose attention mechanisms and generation processes inherently tend toward convergence, and which lack the capacity for active divergence; therefore, divergence must be implemented as a node external to the model. P1 constructs, outside the model, a processing pipeline that does not depend on LLMs: anchored by memory recall and conversational context (contraction), it diverges in parallel through an association network and six disciplinary axes (psychological, informational, social, logical, linguistic, cognitive), produces direction words via spatial additive voting and many-to-one contraction in a shared candidate pool (re-contraction), and ultimately provides a directional framework for the model's generation through prompt injection.

The compendium comprises six chapters: Chapter 1 presents the design philosophy and conceptual framework; Chapter 2 presents the system architecture and step-by-step processing flow; Chapter 3 provides formal descriptions of all algorithms, the scoring framework, and comparisons with related work; Chapter 4 describes the companion memory system (data layer, processing pipeline, dual-track recall, and injection mechanisms); Chapter 5 documents the system's evolutionary history, evaluation framework, and experimental results (including analyses of representative failure cases and a compendium of failed approaches); Chapter 6 describes the linguistic resource system and lexicon design, with a terminology glossary and system status report appended.

## Table of Contents

| Ch. | File | Content |
|---|---|---|
| 1 | [Chapter 1: Design Philosophy and Conceptual Framework](ch1-concepts.md) | Design motivation: three core judgments / Sources of design thinking / Three-stage mechanism overview / Core conceptual framework / Terminology conventions |
| 2 | [Chapter 2: System Architecture and Processing Flow](ch2-architecture.md) | Five-step standard processing chain overview / Overall architecture (node graph, three routes, U-shaped injection) / Per-node specification / Architectural evolution |
| 3 | [Chapter 3: Algorithm Design and Formal Descriptions](ch3-algorithms.md) | Original algorithms itemized (motivation, formulas, design rationale, related-work comparison) / Complete scoring framework specification / Ablation studies and failed approaches / Related work summary table |
| 4 | [Chapter 4: Memory System](ch4-memory.md) | Design foundations (human memory models) / Data layer / Memory processing pipeline / Dual-track recall / Injection mechanisms / Empirical results |
| 5 | [Chapter 5: System Evolution and Experimental Evaluation](ch5-evolution.md) | Three-phase evolutionary history / Design-decision timeline / Evaluation framework and metrics / Scoring trajectories / Representative failure case analyses / Failed-approach compendium |
| 6 | [Chapter 6: Resource System and Appendices](ch6-resources.md) | Linguistic resource system / Lexicon system / Engineering conventions and constraints / Terminology glossary / System status and roadmap |

## Reading Conventions (Uniform Across All Chapters)

1. **Value-source grading.** All numerical values in this text are annotated with their source level: **experimentally calibrated fixed values** (locked by auditable experiments) or **initial defaults (not systematically tuned)**. Shape-level formulas (structures) serve as specification descriptions; specific weights, coefficients, and thresholds are subject to the implementation.
2. **Runtime-status declaration.** The self-driven divergence pipeline and memory-ontology recall described in this book are currently in **component status**: algorithms and components have been implemented and experimentally validated, but have been temporarily removed from the production real-time pipeline; real-time retrieval is handled by the model's preset mechanism. This book describes the implemented component library awaiting reconnection.
3. **Citations.** Except for a very small number of passages annotated as "designer's original words," all content in this book is a normative paraphrase of design intent and implementation.
4. **Related-work grading.** Chapter 3 provides a prior-art comparison for each algorithm, graded as follows: A = mechanism highly similar and published before this system's design (possible convergent invention); B = partially similar (overlapping components, different overall mechanism); C = only conceptually similar terminology; D = no similar published work found. The audit conclusion is A = 0.
5. **Terminology.** Each chapter defines terms at their first occurrence; the full glossary appears in Appendix A of Chapter 6.

