# P1: An LLM-Free Pre-Cognitive Divergence Recall Engine

# Chapter 1: Introduction

> This chapter defines the problem of Pre-Cognitive Divergence—the architectural absence, in LLMs, of multi-dimensional exploration prior to generation—and explains why existing approaches (RAG, pure-LLM divergence, vector search) cannot fill this gap. On this basis it presents the system positioning of P1, the Contraction-Divergence-Contraction (CDC) three-stage processing skeleton, and the five core contributions of this paper, establishing the problem background for the technical details in subsequent chapters.

## 1.1 Problem Definition

The typical workflow of current Large Language Models (LLMs) in dialogue systems is: upon receiving user input, the model directly enters an autoregressive generation process, producing the reply token by token.

The core mechanism of this process—self-attention—is in essence competitive normalization: the softmax function compresses attention scores into a probability distribution, causing the model to focus on the most salient signals in the existing context and to converge progressively toward high-probability output sequences.

In other words, the attention mechanism of LLMs continuously converges toward high-probability outputs at the architectural level, and lacks the ability to actively explore a multi-dimensional space of possibilities before generation.

In actual dialogue, this deficiency manifests as follows: when a user sends a message containing multiple emotional layers, cross-domain implications, or ambiguous intent, the LLM tends to lock onto the single most salient interpretation and respond to it directly, rather than first divergently exploring the knowledge domains the message may touch upon—across psychology, sociology, linguistics, and other dimensions—and then generating a reply with greater depth and breadth on that basis.

In response to this deficiency, the system design establishes a problem positioning orthogonal to the mainstream scaling directions (longer context, multimodality): current LLM research works to enlarge the coverage of attention, but does not address the divergence capability of attention. P1's design choice is a separation of responsibilities—transforming the attention pattern of "contracting a global context of tens of thousands to hundreds of thousands of tokens down to a single focus" into a local exploration pattern of "controlled divergence starting from a single semantic point." This stance—explicitly separating the divergence process from the generation process and externalizing it as an independent stage—is corroborated by work in LLM creativity research that uses external scaffolding to separate divergence from convergence (Scaffolding Creativity, arXiv:2510.26490), and by the empirical finding that divergence capability is uncorrelated with a model's general intelligence (Orwig, 2025).

This paper defines this as-yet unsystematically solved problem as **Pre-Cognitive Divergence**: before the LLM generates a reply, completing a multi-dimensional semantic divergence exploration of the user input at low latency (design acceptance criterion ≤3s; the current implementation measures 300-500ms for warm calls and about 9s for cold loading) and zero token cost, and injecting the divergence results into the LLM's context in the form of **direction words** (covering three types—technical terms, work/scene references, and fragment words; see Section 1.3), so that the model obtains a set of candidate cognitive directions before generation, rather than beginning generation with no directional information at all.

## 1.2 Limitations of Existing Approaches

### 1.2.1 Retrieval-Augmented Generation (RAG) Performs Retrieval, Not Divergence

The core paradigm of RAG (Retrieval-Augmented Generation) (Lewis et al., 2020) is "retrieve-concatenate-generate": relevant passages are retrieved from an external corpus according to the user query, concatenated into the LLM context, and a reply is generated. This paradigm addresses the problems of LLM knowledge cutoff and factual accuracy; its retrieval objective is **exact matching**—finding the document fragments semantically closest to the query.

However, what Pre-Cognitive Divergence requires is not exact matching but **controlled semantic displacement**: starting from the user input, exploring toward medium semantic distances along multiple disciplinary axes (psychology, informatics, sociology, logic, linguistics), and discovering conceptual associations that the user did not state explicitly but that may be relevant.

RAG's vector retrieval pursues maximization of cosine similarity, whereas P1 pursues an optimal semantic distance band (corresponding to the Goldilocks effect in the literature on Mednick's remote association theory; see Section 2.13)—an inverted-U optimal band that is neither synonymous redundancy (distance too small) nor random noise (distance too large). The two objective functions are fundamentally different.

Moreover, RAG produces no new semantic associations at the retrieval stage—it can only find passages that already exist in the corpus, and cannot generate conceptual connections not explicitly present in the corpus through associative networks and cross-domain analogy.

P1's core value lies precisely in this **emergent semantic bridging**: through spreading activation over the SWOW association network, cross-domain structural mapping via Cilin analogy, and directional movement in the Numberbatch vector space, it produces cross-disciplinary direction words that do not exist in the user's original text and that the LLM would find difficult to derive on its own from a bare reading.

### 1.2.2 Pure-LLM Approaches Cannot Achieve LLM-Free Pre-Cognition

Another class of approaches attempts to realize divergent thinking through the LLM itself, for example Chain-of-Thought (Wei et al., 2022), Tree-of-Thoughts (Yao et al., 2023), and various creativity-enhancing prompting techniques (CreativeDC, arXiv:2512.23601; Scaffolding Creativity, arXiv:2510.26490). The common limitations of these approaches are:

**Cost**: Every divergence consumes the LLM's token budget. For dialogue systems requiring real-time responses, an additional LLM call for divergence exploration before every user message means doubled latency and linear growth in API cost. Research shows that an LLM's divergence capability is uncorrelated with its general intelligence score (Orwig, 2025)—investing more compute does not solve the divergence problem.

**Black-box opacity**: The divergence process inside an LLM is unobservable, undebuggable, and cannot be intervened upon step by step. When the output direction drifts, it is impossible to localize which stage went wrong. P1 adopts a fully white-box design: the input, processing, and output of every node can be observed online.

**Controllability**: The divergence results of an LLM are unpredictable—the same input may produce entirely different directions under different temperature sampling, and coverage of the preset multi-disciplinary dimensions cannot be guaranteed. Through the deterministic framework of six-axis face divergence, P1 guarantees that every run systematically covers the psychology, informatics, sociology, logic, linguistics, and other dimensions.

### 1.2.3 Vector Search Cannot Realize Multi-Dimensional Spatial Voting

Embedding-based semantic search (e.g., Word2Vec cosine-similarity retrieval) can find semantically close words, but it operates in a single vector space and cannot realize the **multi-source, multi-axis spatial voting** mechanism that P1 requires.

P1's spatial additive voting pools candidate words from multiple heterogeneous paths—SWOW association, Numberbatch vector neighbors, Cilin analogy, ConceptNet causal chains—into the same space, and performs additive accumulative voting with Inverse Distance Weighting (IDW).

The core insight of this mechanism is: when multiple independent information sources (e.g., the psychology axis, the sociology axis, the linguistics axis) simultaneously point to the same candidate word, that word most likely carries cross-disciplinary resonance value—this is the application of the Condorcet jury theorem (the accuracy of multiple independent voters grows exponentially with the number of voters) to the domain of semantic divergence. KNN search in a single vector space cannot realize this multi-source voting mechanism.

## 1.3 Positioning of P1

P1 is a **Pre-Cognitive Divergence Engine** whose current production route (Route 1) is an **LLM-Free baseline**. It is not RAG (it does not perform exact retrieval; it performs controlled semantic divergence), not an LLM Agent (Route 1 invokes no large language model and consumes zero tokens end to end), and not retrieval augmentation (it does not concatenate external documents; its output is direction-word seeds). Its system positioning is: P1 serves as the "perceptual front end" before the main model generates—just as the visual system provides downstream cognition with a scene representation that has already undergone initial organization, P1 provides the main LLM with a semantic map annotated with candidate cognitive directions, so that generation begins as "exploration with directional priors" rather than from a "blank state with zero direction." In cognitive science, this positioning corresponds to the pre-attentive, parallel preprocessing stage in Feature Integration Theory (Treisman & Gelade, 1980); in prompt engineering, it is consistent with the empirical results of Directional Stimulus Prompting—injecting directional signals before generation significantly alters and improves LLM output quality (DSP, NeurIPS 2023).

In the three-layer division of responsibilities, P1 is responsible for pre-generation semantic localization and divergence—extracting the semantic features of the input and producing multi-dimensional associative directions; the main LLM is responsible for reasoning and reply generation based on the direction words P1 provides; collaborating agents are responsible for executing concrete search and verification tasks. P1's core value lies not in replacing the LLM's comprehension ability, but in compensating for the LLM's architectural contraction bias—through an externalized divergence node, injecting into the LLM cross-disciplinary cognitive directions that it would find difficult to activate on its own.

P1 itself is a **dual-engine design**: Self-Driven P1 (the primary engine, running upfront, free and fast, responsible for recall and divergence) and AIP1 (an optional fallback in which a user-selected LLM continues and deepens the self-driven results; gemini2.5flash is generally used). The designer's definition of the relationship between the two is: the self-driven engine is responsible for content discovery, and AIP1 continues and deepens on top of its results rather than replacing them. The technical description in this paper focuses on Self-Driven P1.

It should be noted that LLM-Free is a property of the current production route, not the design end-state. The LLM annotation layer under design, as a planned component, includes: H5 QKV LoRA (the LLM is responsible only for QKV understanding and direction annotation, outputs no creative content whatsoever, and H1-H4 remain the responsibility of the system layer), Qwen3.5:2B front-end localization (replacing part of the vocabulary-based judgment with a small model), a dual-LoRA 200-case comparison experiment, and a three-route architecture—Route 1 with no LLM (the production baseline described in this paper, approximately 90% complete), Route 2 with the LLM placed before SWOW, Route 3 with the LLM placed after SWOW, and Route C with both positions. Routes 2/3/C have been fully implemented in the lab but not yet merged into the mainline. The design principle is: the optimal solution is a division-of-labor combination of system components and AI, not the replacement of system components by AI.

P1's overall processing skeleton is the three-stage **Contraction-Divergence-Contraction (CDC)** mechanism:

1. **Contraction One (Phase A)**: Extract semantic coordinates from the user input and dialogue history, and construct divergence anchors through memory recall (data-layer memory recall is currently off by default pending validation; the production environment by default enables context recall only);
2. **Divergence (Phase B)**: Starting from the anchors, diverge in parallel along multiple paths—the SWOW association network, the Numberbatch vector space, Cilin analogy, ConceptNet causal chains, and others;
3. **Contraction Two (Phase T)**: Through BLQ (Beilu Linqing Quality) multi-factor voting and ranking, contract hundreds of divergence candidates into layers—a core layer of 4-5 high-quality direction words (corresponding to the working-memory-capacity argument, see Section 2.12) and a broad-recall layer of top15 candidates (corresponding to the low-threshold, wide-coverage semantic-reach design, see Section 2.12)—and inject them into the main LLM's context. Direction words fall into three types: technical terms (the mainstay of chat/work modes), work/scene references (the mainstay of airp mode), and fragment words, corresponding to the design's definition of Contraction Two's function: extract the lexical nature of candidates and convert them into technical terms, work references, or fragment words.

The design acceptance criterion for the entire process is ≤3s (warm calls measured at 300-500ms, cold loading about 9s), with zero LLM token consumption and fully observable output.

## 1.4 Core Contributions

The main contributions of this paper are as follows:

1. **We propose the problem of Pre-Cognitive Divergence and give a systematic solution (with an LLM-Free baseline as the current production route)**. We point out that LLMs lack pre-generation divergent exploration capability at the architectural level, and we design an externalized divergence engine with zero token consumption (Route 1), low latency (design acceptance criterion ≤3s; warm calls measured at 300-500ms), and full white-box observability, which significantly improves the multi-dimensional cognitive coverage of dialogue systems without adding LLM invocation cost.

2. **We design and implement the three-stage Contraction-Divergence-Contraction (CDC) cognitive processing pipeline**. This pipeline integrates spreading activation theory (Collins & Loftus, 1975), structure mapping theory (Gentner, 1983), information bottleneck theory (Tishby, 1999), and other multi-disciplinary theories, formalizing the human cognitive rhythm of "first contract to anchors, then diverge associatively, then contract into action" as a computable twelve-stage pipeline.

3. **We propose the spatial additive voting mechanism and the BLQ multi-factor ranking algorithm**. We transfer the many-to-one voting paradigm of the Hough transform from computer vision to NLP direction-word generation, and draw on the design ideas of classical information retrieval techniques such as RRF (Reciprocal Rank Fusion), lateral inhibition, and MMR (Maximal Marginal Relevance) (the implementation status of each mechanism is annotated item by item in Chapter 2), realizing a layered, robust contraction from hundreds of divergence candidates to "core layer 4-5 + broad-recall layer top15" direction words.

4. **We establish a formal evaluation framework for direction-word quality**. We propose original quality criteria such as **null-value terms** (words the main model could derive from a bare reading of the original text, hence of zero value) and **over-generic terms** (generalized words activated in 80%+ of scenarios), and design a five-dimension scoring system (contextual connection, direction-versus-route distinction, direction-word quality, multi-head capture, analogical divergence) for the systematic evaluation of divergence output quality.

5. **We open-source the complete system implementation and a 55GB multilingual cognitive resource library**. This includes 14 integrated resources—SWOW-ZH24 (10,024 cue words), ConceptNet Numberbatch (294,716 Chinese words + 344K English words, 300 dimensions), the ConceptNet inverted index (260,236 words, 453,956 edges), NRC-VAD v2 (54,801 words), DomainWordsDict (561,000 words across 69 domains)—and 42+ integrable resources.

## 1.5 Paper Organization

The remainder of this paper is organized as follows. Chapter 2 reviews related work, covering spreading activation theory, retrieval-augmented generation, memory-augmented LLMs, cognitive architectures, word embedding spaces, free association networks, and information retrieval. Chapter 3 describes the overall design of the P1 system architecture and processing pipeline. Chapter 4 details the core algorithms, including SWOW spreading activation, six-axis face divergence, spatial additive voting, and BLQ multi-factor ranking.

Chapter 5 introduces the direction-word quality evaluation framework and experimental setup. Chapter 6 reports experimental results and ablation analyses. Chapter 7 discusses system limitations and future work. Chapter 8 concludes the paper.

---

# Chapter 2: Related Work

> This chapter spans the three fields of cognitive science, natural language processing, and information retrieval, reviewing section by section 14 research directions closely related to P1—spreading activation, RAG, memory-augmented LLMs, cognitive architectures, word embeddings, and others. Together these works constitute the theoretical reference frame for P1's design choices—only by understanding their boundaries can one understand why P1's positioning of "Pre-Cognitive Divergence" has not yet been covered by existing research. Each section follows a similar structure: first the relevant theory/method is introduced, then the connections and distinctions between P1 and it are explained.

The design of the P1 system spans cognitive science, natural language processing, and information retrieval. This chapter reviews the research directions most closely related to P1 in descending order of relevance, and clarifies the connections and distinctions between P1 and each direction.

## 2.1 Spreading Activation Theory

The Spreading Activation Theory proposed by Collins and Loftus (1975) is the primary theoretical foundation of P1's divergence mechanism. The theory holds that human semantic memory is organized as a network: concepts are nodes and semantic relations are edges; when a concept is activated, the activation signal propagates along connecting edges to adjacent concepts, decaying exponentially with propagation distance.

This theory explains the Semantic Priming Effect—presenting "doctor" first accelerates recognition of "nurse" (Meyer & Schvaneveldt, 1971).

P1's core divergence mechanism is directly based on the spreading activation model: with the meaningful words obtained after tokenization as seed nodes, activation spreads through the SWOW association network, with activation strength decreasing by distance (distance=0 original word 1.0 / distance=1 direct association 0.6 / distance=2 indirect association 0.3); each spread produces approximately 120-150 activated nodes. However, P1 goes beyond the classical spreading activation model in three respects:

**First, P1 adopts information-pool divergence rather than per-word divergence.** Classical spreading activation starts from a single seed node; P1 instead pools the activation results of all seed words into a single information pool and searches for resonance points in the overall semantic space of the pool. This design originates from a design red-line rule: it is forbidden to diverge each word independently and then simply sum the divergence results—that operation produces large numbers of over-generic terms (generalized words activated in most scenarios), by a mechanism cognate with the Fan Effect (Anderson, 1974): high-connectivity association nodes are repeatedly activated by multiple seed words, so generalized words systematically win out in the summation.

**Second, P1 overlays multi-axis spatial voting on top of spreading activation.** The scattered-word pool produced by spreading activation is projected onto six disciplinary axes (psychology, informatics, sociology, logic, linguistics, cognitive science); each axis scores independently and the scores flow into spatial additive voting, so that the final selection of direction words is based on cross-validation across multiple independent dimensions rather than a single associative chain.

**Third, P1 introduces a two-pass divergence architecture.** The first divergence (the SWOW association network) produces the scattered-word pool; after narrowing by spatial voting, a second divergence (cross-domain association, attribution chains, analogical mapping, and other paths) produces information words, which are finally contracted into direction words through Hough-style many-to-one voting. This heterogeneous two-hop structure has no precedent in the spreading activation literature.

In recent years, the application of spreading activation theory in NLP has received renewed attention. SYNAPSE (arXiv:2601.02744, 2025) combines spreading activation with lateral inhibition for knowledge graph retrieval. SA-RAG (Pavlovic et al., arXiv:2512.15922, 2025) uses SWOW association data as the spreading layer of a RAG system, adopting an additive accumulation mechanism.

P1 shares the theoretical foundation of spreading activation with these works, but differs fundamentally in system positioning: SYNAPSE and SA-RAG still serve the goal of exact retrieval, whereas P1's goal is controlled semantic divergence—finding cross-domain direction words that exceed the range of direct association, with every step of the association traceable to evidence.

## 2.2 Retrieval-Augmented Generation (RAG)

Retrieval-Augmented Generation, since its proposal by Lewis et al. (2020), has become the mainstream paradigm for mitigating LLM hallucination and knowledge cutoff. The standard RAG pipeline comprises: query encoding, vector retrieval, passage concatenation, and reply generation.

Subsequent work has continued to improve retrieval quality (Gao et al., 2023 HyDE; Gutierrez et al., 2024 HippoRAG), context compression (LLMLingua-2, ICLR 2025), and multi-hop reasoning (GRF, Ji et al., EMNLP 2020).

P1 and RAG differ fundamentally at three levels—system objective, retrieval strategy, and output form:

**System objective**: RAG's objective is to provide the LLM with factual knowledge ("what is the answer to this question"); P1's objective is to provide the LLM with cognitive directions ("from what angles can this question be considered"). The former pursues exact matching; the latter pursues controlled semantic displacement.

**Retrieval strategy**: RAG adopts high-threshold exact recall (Top-K by cosine similarity ranking); P1 adopts low-threshold, high-volume marginal recall ("prefer over-inclusion to omission"). P1's memory recall does not pursue high precision; rather, it provides the downstream divergence with the broadest possible set of anchors. This bears a conceptual similarity to the Personalized PageRank random-walk retrieval of HippoRAG (Gutierrez et al., NeurIPS 2024), but HippoRAG's PPR still serves the goal of exact retrieval.

**Output form**: RAG outputs natural-language passages (external knowledge for the LLM to consult directly); P1 outputs minimal direction words (core layer 4-5 + broad-recall layer top15—a small number of lexical items that activate a much larger range of relevant knowledge modules in the main LLM; the types cover technical terms, work/scene references, and fragment words, see Section 1.3). The experiments of Cognitive Priming in LLMs (arXiv:2409.16022) show that LLMs are indeed affected by the semantic priming effect—this provides indirect, mechanism-level support for the priming effect of P1's direction words on the main LLM (P1's own injection-controlled experiment has not yet been conducted).

Particularly worth mentioning are Cog-RAG (AAAI, 2026) and EcphoryRAG (arXiv:2510.08958, 2025). The former introduces a cognitive dual hypergraph for two-stage retrieval; the latter draws on the ecphory mechanism of memory to realize cue-driven multi-hop associative search. These works have begun to bring cognitive science theory into retrieval system design and intersect with P1's design approach of borrowing cognitive-science mechanisms, but they remain positioned as retrieval augmentation rather than cognitive divergence.

## 2.3 Memory-Augmented Large Language Models

MemGPT (Packer et al., 2023) pioneered the direction of adding explicit memory management to LLMs, using a virtual paging mechanism to let an LLM manage unlimited historical information within a finite context window. Subsequent work such as ReadAgent (Lee et al., 2024) and MemoryBank (Zhong et al., 2024) further developed storage, indexing, and recall strategies for long-term memory.

The beilu memory system on which P1 depends adopts a Hot/Warm/Cold three-layer architecture: the hot layer stores permanent memories and the user profile, injected in full every turn (working memory); the warm layer covers dialogue summaries from the past month, recalled on demand (recent episodic memory); the cold layer stores memories older than a month, triggered only by keywords (long-term semantic memory). The decay formula `score = weight * 1/(1+days*0.1)` simulates the forgetting curve, and a review-reinforcement mechanism (entries hit by actual injection have their trigger time refreshed) implements spaced repetition. This memory system belongs to the beilu host side, not to P1 as a subsystem—P1 consumes only its marginal recall through the broad-recall divergence line.

The core distinction between this memory system and approaches such as MemGPT is: MemGPT's memory management serves efficient utilization of the context window (letting the LLM "remember" more), whereas P1 consumes memory recall for the purpose of constructing divergence anchors (giving divergence a "starting point"). The beilu memory system designs a Dual-Line Recall mechanism: the host exact line serves precise injection with four-dimensional additive scoring (semantic, literal, recency, importance); the broad-recall divergence line serves P1's divergence anchors with an extremely low threshold under which a single word hit counts as marginal recall. The two are physically isolated and do not interfere with each other.

## 2.4 Cognitive Architectures

If Section 2.3 discussed how P1 organizes "what to remember," this section concerns the more upstream question—which general cognitive models P1's processing rhythm itself draws on. ACT-R (Anderson, 1983; Anderson et al., 2004) and SOAR (Laird, 2012) are the two most influential general cognitive architectures. ACT-R's declarative memory module adopts an activation-value model: the activation value of each memory chunk is composed of base-level activation (related to usage frequency and recency) and spreading activation (related to associative strength with the current focus of attention). SOAR adopts problem-space search based on production rules, and compiles successful search paths into directly triggered rules through a chunking mechanism.

P1 draws on the ideas of cognitive architectures at multiple levels:

- **ACT-R's frequency decay**: The actrDecay factor in P1's BLQ algorithm directly adopts ACT-R's frequency-accumulation decay model; candidate words that appear at high frequency (corresponding to high-activation memory chunks in ACT-R) are moderately down-weighted to avoid generalized output caused by the Fan Effect (Anderson, 1974).

- **ACT-R's subgoal activation**: P1's two-pass divergence architecture—the first divergence produces the scattered-word pool (corresponding to ACT-R's retrieval stage), spatial voting produces anchors (corresponding to ACT-R's pattern matching), and the second divergence produces information words (corresponding to ACT-R's subgoal setting)—is structurally isomorphic to ACT-R's retrieve-match-execute cycle (arXiv:2408.09176).

- **An extension of Kahneman's dual-system theory**: In its design P1 references Kahneman's (2011) fast-and-slow thinking theory and extends it into a three-system model: System 0 (the perceptual layer, corresponding to P1's tokenization and initial feature extraction), System 1 (the intuitive layer, corresponding to P1's spreading activation and rapid association), and System 2 (the deliberative layer, corresponding to the main LLM's generation process).

However, the fundamental distinction between P1 and ACT-R/SOAR lies in positioning: cognitive architectures pursue the construction of general cognitive models, whereas P1 pursues maximum cognitive compensation at minimum cost in one specific stage (divergent exploration before LLM generation). P1 does not attempt to simulate the complete cognitive process; instead, it precisely localizes the LLM's contraction bias and compensates for it at the architectural level with an externalized component.

## 2.5 Word Embedding Spaces

Section 2.4 discussed borrowing at the process level; this section turns to the representation level: what kind of vector space P1 uses to carry the semantic computations in these processes. Word2Vec (Mikolov et al., 2013) inaugurated the era of distributed word vector representations and revealed the linear structure of word vector spaces: `vec("king") - vec("man") + vec("woman") ≈ vec("queen")`. GloVe (Pennington et al., 2014) improved word vector quality through global co-occurrence matrix factorization.

ConceptNet Numberbatch (Speer et al., 2017) further fuses knowledge graph information on this basis, aligning Word2Vec/GloVe vectors with the ConceptNet knowledge graph through retrofitting, producing a multilingual word vector space that combines distributional statistical features with structured commonsense knowledge.

P1 uses ConceptNet Numberbatch (300 dimensions, 294,716 Chinese words + 344K English words) as its core vector resource. Its application covers the following three stages (implementation status differs by stage and is annotated item by item):

- **Vector-space divergence** (design plan, Phase B2; currently in commented-out code state, not running in the current 12-stage production pipeline): in the Numberbatch space, starting from the weighted centroid of the input words, move along an emotion direction vector and search for candidate terms near the target point. This is the planned step in P1's evolution from discrete table-lookup retrieval toward continuous vector-space search.

- **Analogical reasoning** (design reference, not running as an implemented mechanism): Mikolov's vector analogy formula A:B::C:? provides a theoretical reference for structural analogical divergence; the analogy implementation in the current production pipeline is cross-domain expansion at Cilin major-category code distance 4-5 plus NB cosine filtering within the optimal semantic distance band (see Section 2.9), not the parallelogram operation.

- **Lateral inhibition** (design plan, listed in the P1-level not-yet-implemented list, not running in the current production pipeline): when the cosine similarity of two candidate direction words exceeds 0.7, the one with the weaker activation value is inhibited (multiplied by 0.3), ensuring output diversity.

The distinction between P1 and pure word-embedding methods is: word embeddings provide a static semantic distance metric, on top of which P1 builds a dynamic multi-axis spatial voting mechanism—word embeddings are only one of P1's multiple divergence paths, and their results must undergo additive voting together with heterogeneous signal sources such as SWOW association, Cilin analogy, and ConceptNet causal chains before the final direction words are produced.

## 2.6 Conceptual Spaces Theory

The Conceptual Spaces Theory of Gardenfors (2000, 2004, 2025) proposes that concepts are convex regions in a high-dimensional space, and semantic relations can be described by geometric properties (distance, angle, region containment). This theory provides the theoretical anchoring for P1's multi-axis coordinate system.

P1's BLQ-Coord multi-axis word coordinate system directly corresponds to the core claim of conceptual spaces theory: each word is represented as a structured sparse vector, and the six disciplinary axes (psychology, informatics, sociology, logic, linguistics, cognitive science) are different projections of the same coordinate space.

The layered architecture comprises: Layer 1, multi-axis word coordinates (static axes + dynamic axes + embedding axes); Layer 2, anchor multi-axis queries (parallel pure table lookup); Layer 3, cross-axis voting (multiple disciplines all judging a word relevant = cross-disciplinary resonance, converging evidence).

P1's distinctive application of conceptual spaces theory lies in the notion of the "face": the output of each disciplinary axis is not a single score (a "line") but a rich set of associated information words (a "face"). This design rule—"emit faces, not lines"—ensures that the divergence output preserves multi-dimensional semantic structure rather than being compressed into an uninterpretable scalar.

## 2.7 Small World of Words (SWOW)

SWOW (De Deyne et al., 2019) is a lexical network dataset based on large-scale human free-association experiments. In the experiments, participants see a cue word and are asked to quickly report the first three words that come to mind.

SWOW thus captures the most natural associative relations in human semantic memory—unlike the logical relations annotated by experts in knowledge graphs (IsA / PartOf), and unlike the distributional relations inferred from corpus co-occurrence statistics in word embeddings, SWOW reflects the spontaneous association patterns of humans under unconstrained conditions.

P1 uses the official SWOW-ZH24 release (10,024 cue words) as the data source of its core divergence engine. The system design establishes the relationship between P1 and SWOW as a two-part division of labor, "divergence core + adapter": the SWOW association network bears the core divergence function, and BLQ bears the adapter function—converting raw association output into direction words with disciplinary orientation. In the course of system iteration the designer further established a key engineering judgment: the system's quality bottleneck lies in localization, not divergence—SWOW associative spreading itself keeps the semantic topic from drifting (consistent with the property that SWOW data faithfully reflects human spontaneous association patterns, De Deyne et al., 2019), and semantic drift is concentrated in the adapter stage where association words are converted into direction words.

This positioning means that P1 does not attempt to improve the SWOW association data itself; rather, on top of the high-quality associations SWOW provides, it converts raw association words into direction words with disciplinary orientation through the downstream multi-axis localization and spatial voting mechanisms (BLQ as the algorithmic framework of the adapter).

In its use of SWOW, P1 follows an experimentally validated red-line rule: **synonym/antonym dictionary-type resources are forbidden from entering the spread side and are allowed only on the score side as reference**. Measurements show that admitting synonyms into the spread side causes catastrophic degradation of recall quality (beilu recall drops from 0.684 to 0.162; lccc recall drops by 55%). SWOW associative spreading itself runs at distance=1-2 (direct association / indirect association); another easily confused parameter, "distance 4-5," is the Cilin major-category code distance, a cross-domain parameter of analogical divergence (see Section 2.9), unrelated to SWOW association hop count.

SWOW-ZH (Behavior Research Methods, 2025) provides normed data for the Chinese free-association network; P1's Chinese associative divergence is based directly on this dataset. In addition, P1 integrates JWSAN (Japanese) and SWOW-DE (German) data, providing the data foundation for multilingual divergence.

## 2.8 ConceptNet and Commonsense Reasoning

ConceptNet (Speer et al., 2017) is a large-scale multilingual commonsense knowledge graph containing 14 core semantic relations (IsA, Causes, HasProperty, PartOf, CapableOf, UsedFor, etc.). P1 uses an inverted, simplified version of ConceptNet (260,236 head words, 453,956 total edges), mainly for the following two stages:

- **Causal Divergence**: Through ConceptNet's causal-class relations (Causes, HasProperty, CapableOf, MotivatedByGoal, etc.), trace the possible causal chains of an input concept, diverging to concepts that are causally related but semantically more distant.

- **Abstract seed extraction**: From the main-axis concepts, abstract one step upward through IsA/Causes relations to obtain superordinate concepts as seeds for the second divergence.

P1 currently adopts a weighted utilization scheme over 12 ConceptNet relations, with weights forming a gradient by causal strength (from Causes 0.9 decreasing to Antonym 0.01); six-degree paths use full-relation traversal of ConceptNet. The IsA inverted index (a dedicated index structure for semantic superordinate expansion) remains listed as a high-priority resource pending integration.

YARN (2026) proposes a four-step framework for analogical reasoning—decompose, abstract, map, infer—and P1's cross-framework analogy mechanism corresponds closely to this framework: first decompose the input structure in the association space, then perform one step of abstraction through ConceptNet, then search for structurally isomorphic mappings across domains. The Conceptual Blending Theory of Fauconnier and Turner provides theoretical support for P1's cross-axis crossover mechanism—the bidirectional merging of two input spaces can produce emergent structure.

## 2.9 Structure Mapping and Analogical Reasoning

Gentner's (1983) Structure Mapping Theory (SMT) is the direct theoretical source of P1's analogical divergence. SMT's core claim is: the essence of analogy is the mapping of relational structure, not the similarity of attributes—"analogy = finding similar relations, not finding similar objects." FAME (EMNLP, 2023) raised the accuracy of automatic analogical mapping to 81.2%; Relation Embedding Chains (EMNLP, 2023) solved hard analogy problems through chains of relation embeddings.

P1's analogical divergence mechanism (the Cilin analogy expansion, analogyExpand) is designed on the basis of SMT: in Cilin (a Chinese synonym thesaurus), it searches for words at major-category code distance 4-5—words that belong semantically to entirely different domains but occupy isomorphic positions in Cilin's classification hierarchy.

The ranking of the three types of divergence value—analogical divergence (cross-domain structural isomorphism, highest) > same-kind divergence (within-domain expansion, medium) > literal association (semantic neighbors, lowest)—directly reflects SMT's emphasis that relational mapping outranks attribute similarity.

P1 defines three satisfaction conditions for analogical divergence: (1) a mapping can be performed (relational structure correspondence); (2) theoretical fusion is possible (a theory from domain A can be applied to domain B); (3) it is grounded in a property framework (a shared abstract property). This corresponds in part to the four-constraint theory of Holyoak and Thagard (1989) (structural, semantic, pragmatic, and practical constraints).

## 2.10 Information Retrieval

Section 2.9 concerned where candidate words come from (how analogical mapping produces cross-domain associations); this section turns to the question after candidates are produced: how hundreds of candidates are ranked, fused, and narrowed into the final output. P1's ranking and fusion mechanisms draw extensively on classical information retrieval techniques:

**CombSUM (Fox & Shaw, 1994)**: P1's BLQ algorithm adopts weighted linear summation (CombSUM) as its multi-factor fusion strategy, rather than product fusion. The design rationale is "additivity as an OR gate"—additive scoring allows a weak showing on one dimension to be compensated by strong showings on others, avoiding the AND-gate effect of product fusion in which the whole tends to zero whenever any single factor tends to zero.

**RRF (Cormack et al., 2009)**: BLQ's multi-factor fusion adopts the Reciprocal Rank Fusion formula `RRF_score(term) = Sum_over_factors(weight_f / (k + rank_f(term)))` (k=60); each factor is ranked independently and then fused by rank position, which is naturally robust to scale differences among heterogeneous signal sources.

**MMR (Carbonell & Goldstein, 1998)**: MMR once served as the diversity-guarantee mechanism in P1's old monolithic pipeline (Phase E): `MMR(d) = lambda * Sim(d, Q) - (1-lambda) * max(Sim(d, d_selected))`, with lambda at 0.7 (fixed) or adaptively adjusted. This mechanism belongs to the old pipeline design and does not run in the current 12-stage production pipeline.

**BM25 (Robertson et al., 1995)**: In its memory-recall scoring, P1 uses BM25's TF-saturation idea—the marginal contribution of term frequency diminishes, preventing high-frequency words from dominating the ranking.

**IDF (Sparck Jones, 1972)**: P1's v14 version introduces IDF weighting for term-discriminativeness evaluation at the memory-recall stage.

P1 combines these classical techniques into a unified ranking framework, but its objective function is fundamentally different from that of traditional information retrieval: information retrieval pursues "finding the documents most relevant to the query" (relevance maximization), whereas P1 pursues "finding direction words that maintain a controlled semantic distance from the input" (controlled semantic divergence).

This difference in objective function dictates that P1 systematically reworks these classical techniques when using them—for example, combining IDW (inverse distance weighting) with temperature-scaled radius scoping, forming a distance-band control strategy of "too close excluded (null-value terms), too far attenuated (noise), the middle band optimal."

## 2.11 Cognitive Priming and LLM Behavior

P1's final product—direction words—exerts influence on the LLM's generation process by injection into its context; the theoretical basis of this mechanism is Cognitive Priming. In classical psychology, the semantic priming effect has been validated by extensive experiments (Meyer & Schvaneveldt, 1971; Neely, 1977). Recent research extends this effect to the LLM domain:

- **Cognitive Priming in LLMs** (arXiv:2409.16022): experiments demonstrate that LLMs are indeed affected by priming—presenting particular concepts in context significantly alters the semantic direction of the LLM's subsequent generation. The subject of that experiment is the general priming effect in LLMs; it provides indirect, mechanism-level support for the priming effect of P1's direction words on the main LLM (P1's own injection-controlled experiment has not yet been conducted).

- **Serial Position Effect in LLMs** (ICLR, 2026; arXiv:2604.10027): an LLM's attention to information at different positions in the context follows a U-shaped distribution—information at the head and tail receives more attention (primacy and recency effects), while information in the middle receives the least. Based on this, P1 designs a U-shaped injection strategy: the strongest direction word is placed first (primacy effect), the second-strongest last (recency effect), and the weakest in the middle.

- **Creativity and Associative Thinking** (Nature npj, 2025): associative ability explains 50% of the variance in divergent thinking, providing cognitive-science support for P1's design of driving divergence with an association network.

- **Concise Paths 2-3 Hops Sufficient** (2025): concise 2-3-hop paths suffice for robust reasoning, validating P1's design choice of simplifying six degrees of separation to 2-3 steps.

- **DSP (Directional Stimulus Prompting)** (NeurIPS, 2023): directional prompting can improve LLM performance by 41.4%, supporting from a prompt-engineering perspective P1's output policy of "give directions, not routes."

## 2.12 Working Memory Capacity and the Information Bottleneck

Miller's (1956) magical number 7+/-2 and Cowan's (2001) revised working-memory capacity limit of 4+/-1 set the cognitive-science basis for P1's direction-word output quantity: P1's core-layer direction words are held to 4-5, falling exactly within the optimal capacity range of human working memory. Too many direction words dilute attention; too few fail to provide sufficient multi-dimensional coverage. Coexisting with the core layer is the broad-recall layer output (top15 candidates), which follows the design intent of tolerating low-value candidates and trading a low threshold for wide-coverage semantic reach—the core layer enters the focus of attention, the broad-recall layer provides wide-coverage semantic reach, and the two layers each perform their own role without contradiction.

The Information Bottleneck Theory of Tishby and Zaslavsky (1999) provides the formal framework for P1's compression-retention trade-off: P1's divergence process produces hundreds of candidates, ultimately compressed into a core layer of 4-5 direction words—the objective of this compression is to maximize the mutual information between the direction words and the quality of the LLM's final output, while minimizing the redundant information between the direction words and the original input.

The ibApprox (information bottleneck approximation) factor in P1's BLQ algorithm corresponds directly to this theoretical objective.

Sims (2018, 2023) applied Rate-Distortion theory to the formal modeling of human working memory, finding that the capacity limit of human working memory can be explained by the information-theoretic rate-distortion trade-off. P1's objective function is isomorphic to this formal model: direction words are a lossy compression of the input semantic space, and the compression objective is to retain the dimensions that contribute most to the main LLM's reply quality.

## 2.13 Weak Ties Theory and Serendipity

Granovetter's (1973) Strength of Weak Ties theory states that in social networks, weak ties (acquaintances contacted infrequently) are more likely than strong ties (close friends) to transmit new information, because weak ties bridge different social circles.

P1's six-degree-of-separation bonus mechanism is directly based on this theory: cross-domain divergence paths (connections passing through multiple different disciplinary domains) receive an increasing bonus coefficient (spanning 2 domains 1.2x / 3 domains 1.4x / 4 domains 1.6x), encouraging the system to discover cross-domain "weak ties"—connections that appear unrelated within any single domain but may provide the LLM with entirely new dimensions of thought.

This design echoes Mednick's (1962) remote association theory (Remote Associates Test, RAT): the core of creative thinking is establishing connections between semantically distant concepts. P1's optimal semantic distance band design (measured in cosine similarity, split into two parameters: the recall Goldilocks band cos [0.25, 0.70] and the analogical divergence band cos [0.2, 0.7]) and its inverted-U value function (too close is synonymous redundancy, too far is random noise, the middle is most valuable) are precisely the computational realization of this theory.

Orwig's (2025) experiments further confirm that the relationship between semantic distance and creativity is indeed a nonlinear inverted U.

## 2.14 Other Related Work

**Hough transform and voting mechanisms**: P1's many-to-one voting mechanism draws on the Hough transform proposed by Hough (1962) in computer vision—multiple evidence points vote independently for the same hypothesis, and the hypothesis with the most votes is selected. VoteNet (ICCV, 2019) extended Hough voting to 3D object detection. P1 further transfers this paradigm to NLP direction-word generation: multiple information words vote for the same candidate direction word, and the highest-voted candidate is selected as the final output. This transfer has no precedent in the public literature.

**Halliday's Systemic Functional Linguistics (SFL)**: Halliday's (1994) three metafunctions (ideational, interpersonal, textual) influenced the design of the sub-directions on P1's linguistics axis—word-sense analysis corresponds to the ideational function, mode of conveyance to the textual function, and pragmatic analysis to the interpersonal function.

**FIT, Feature Integration Theory**: Treisman's (1980) Feature Integration Theory distinguishes a pre-attentive stage (features on each dimension processed in parallel and independently) from an attentive stage (features bound into a unified object). P1's six-axis face divergence (each axis running in parallel and independently) corresponds to the pre-attentive stage, and spatial additive voting (multi-axis results pooled into the same space) corresponds to the feature binding of the attentive stage.

**Temperature parameters and the Boltzmann distribution**: P1's temperature parameter design references the Boltzmann distribution `exp(-E/kT)`—the temperature value controls the size of the candidate search range: high temperature corresponds to a larger search range (divergence), low temperature to a smaller one (contraction). P1's axis decay formula `exp(-rank * beta)` likewise adopts an exponential decay form, with beta=0.5 as the experimentally calibrated fixed setting.

**Voting theory**: P1's many-to-one voting mechanism implicitly exploits the Condorcet jury theorem—when the individual accuracy of N independent voters exceeds 0.5, collective accuracy grows exponentially with N. With 3 votes accuracy exceeds 87.5%, with 5 votes 96.9%; this provides the probability-theoretic guarantee for P1's requirement that "a direction word must be pointed to simultaneously by multiple independent information sources."

---

## References

[1] Anderson, J.R. (1974). Retrieval of propositional information from long-term memory. *Cognitive Psychology*, 6(4), 451-474.

[2] Anderson, J.R. (1983). *The Architecture of Cognition*. Harvard University Press.

[3] Anderson, J.R., Bothell, D., Byrne, M.D., Douglass, S., Lebiere, C., & Qin, Y. (2004). An integrated theory of the mind. *Psychological Review*, 111(4), 1036-1060.

[4] Carbonell, J., & Goldstein, J. (1998). The use of MMR, diversity-based reranking for reordering documents and producing summaries. In *Proceedings of SIGIR*, 335-336.

[5] Collins, A.M., & Loftus, E.F. (1975). A spreading-activation theory of semantic processing. *Psychological Review*, 82(6), 407-428.

[6] Cormack, G.V., Clarke, C.L.A., & Buettcher, S. (2009). Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning methods. In *Proceedings of SIGIR*, 758-759.

[7] Cowan, N. (2001). The magical number 4 in short-term memory: A reconsideration of mental storage capacity. *Behavioral and Brain Sciences*, 24(1), 87-114.

[8] De Deyne, S., Navarro, D.J., Perfors, A., Brysbaert, M., & Storms, G. (2019). The "Small World of Words" English word association norms for over 12,000 cue words. *Behavior Research Methods*, 51(3), 987-1006.

[9] Fauconnier, G., & Turner, M. (2002). *The Way We Think: Conceptual Blending and the Mind's Hidden Complexities*. Basic Books.

[10] Fox, E.A., & Shaw, J.A. (1994). Combination of multiple searches. In *Proceedings of TREC-2*, 243-252.

[11] Gao, L., Ma, X., Lin, J., & Callan, J. (2023). Precise zero-shot dense retrieval without relevance labels. In *Proceedings of ACL*, 1762-1777.

[12] Gardenfors, P. (2000). *Conceptual Spaces: The Geometry of Thought*. MIT Press.

[13] Gardenfors, P. (2004). Conceptual spaces as a framework for knowledge representation. *Mind and Matter*, 2(2), 9-27.

[14] Gentner, D. (1983). Structure-mapping: A theoretical framework for analogy. *Cognitive Science*, 7(2), 155-170.

[15] Granovetter, M.S. (1973). The strength of weak ties. *American Journal of Sociology*, 78(6), 1360-1380.

[16] Gutierrez, B., et al. (2024). HippoRAG: Neurobiologically inspired long-term memory for large language models. In *Proceedings of NeurIPS*.

[17] Halliday, M.A.K. (1994). *An Introduction to Functional Grammar* (2nd ed.). Edward Arnold.

[18] Holyoak, K.J., & Thagard, P. (1989). Analogical mapping by constraint satisfaction. *Cognitive Science*, 13(3), 295-355.

[19] Hough, P.V.C. (1962). Method and means for recognizing complex patterns. US Patent 3,069,654.

[20] Hu, E.J., et al. (2021). LoRA: Low-rank adaptation of large language models. *arXiv preprint arXiv:2106.09685*.

[21] Ji, H., et al. (2020). Graph-based reasoning for multi-hop question answering. In *Proceedings of EMNLP*, 4673-4683.

[22] Kahneman, D. (2011). *Thinking, Fast and Slow*. Farrar, Straus and Giroux.

[23] Laird, J.E. (2012). *The Soar Cognitive Architecture*. MIT Press.

[24] Lewis, P., et al. (2020). Retrieval-augmented generation for knowledge-intensive NLP tasks. In *Proceedings of NeurIPS*, 9459-9474.

[25] Mednick, S.A. (1962). The associative basis of the creative process. *Psychological Review*, 69(3), 220-232.

[26] Meyer, D.E., & Schvaneveldt, R.W. (1971). Facilitation in recognizing pairs of words: Evidence of a dependence between retrieval operations. *Journal of Experimental Psychology*, 90(2), 227-234.

[27] Mikolov, T., Chen, K., Corrado, G., & Dean, J. (2013). Efficient estimation of word representations in vector space. *arXiv preprint arXiv:1301.3781*.

[28] Miller, G.A. (1956). The magical number seven, plus or minus two: Some limits on our capacity for processing information. *Psychological Review*, 63(2), 81-97.

[29] Orwig, W., et al. (2025). Semantic distance and creative thinking: A non-linear relationship. *Nature npj Science of Learning*.

[30] Packer, C., et al. (2023). MemGPT: Towards LLMs as operating systems. *arXiv preprint arXiv:2310.08560*.

[31] Pavlovic, D., et al. (2025). SA-RAG: Spreading activation for retrieval-augmented generation. *arXiv preprint arXiv:2512.15922*.

[32] Pennington, J., Socher, R., & Manning, C.D. (2014). GloVe: Global vectors for word representation. In *Proceedings of EMNLP*, 1532-1543.

[33] Robertson, S.E., Walker, S., Jones, S., Hancock-Beaulieu, M.M., & Gatford, M. (1995). Okapi at TREC-3. In *Proceedings of TREC-3*, 109-126.

[34] Sims, C.R. (2018). Efficient coding explains the universal law of generalization in human perception. *Science*, 360(6389), 652-656.

[35] Sparck Jones, K. (1972). A statistical interpretation of term specificity and its application in retrieval. *Journal of Documentation*, 28(1), 11-21.

[36] Speer, R., Chin, J., & Havasi, C. (2017). ConceptNet 5.5: An open multilingual graph of general knowledge. In *Proceedings of AAAI*, 4444-4451.

[37] Tishby, N., Pereira, F.C., & Bialek, W. (1999). The information bottleneck method. In *Proceedings of the 37th Allerton Conference*, 368-377.

[38] Treisman, A.M., & Gelade, G. (1980). A feature-integration theory of attention. *Cognitive Psychology*, 12(1), 97-136.

[39] Wei, J., et al. (2022). Chain-of-thought prompting elicits reasoning in large language models. In *Proceedings of NeurIPS*.

[40] Yao, S., et al. (2023). Tree of thoughts: Deliberate problem solving with large language models. In *Proceedings of NeurIPS*.

[41] SYNAPSE (2025). Spreading activation with lateral inhibition for knowledge graph traversal. *arXiv preprint arXiv:2601.02744*.

[42] FAME (2023). Frame-aware analogical mapping engine. In *Proceedings of EMNLP*.

[43] Cog-RAG (2026). Cognitive dual-hypergraph retrieval-augmented generation. In *Proceedings of AAAI*.

[44] EcphoryRAG (2025). Ecphory-inspired multi-hop associative retrieval. *arXiv preprint arXiv:2510.08958*.

[45] Cognitive Priming in LLMs (2024). *arXiv preprint arXiv:2409.16022*.

[46] Serial Position Effect in LLMs (2026). *arXiv preprint arXiv:2604.10027*, ICLR 2026.

[47] DSP: Directional Stimulus Prompting (2023). In *Proceedings of NeurIPS*.

[48] LLMLingua-2 (2025). Context compression via information bottleneck. In *Proceedings of ICLR*.

[49] YARN (2026). Analogical reasoning: Decompose-abstract-map-infer.

[50] Relation Embedding Chains (2023). Solving hard analogies via relation embedding chains. In *Proceedings of EMNLP*.

[51] VoteNet (2019). Deep Hough voting for 3D object detection. In *Proceedings of ICCV*.

[52] HippoRAG 2 (2025). Deeper passage integration for neurobiologically inspired retrieval. In *Proceedings of ICML*.

[53] Friston, K. (2005). A theory of cortical responses. *Philosophical Transactions of the Royal Society B*, 360(1456), 815-836.

[54] Schank, R.C., & Abelson, R.P. (1977). *Scripts, Plans, Goals and Understanding*. Lawrence Erlbaum Associates.

[55] CreativeDC (2025). Creative divergent chains for LLMs. *arXiv preprint arXiv:2512.23601*.

[56] Scaffolding Creativity (2025). External scaffolding for separating divergence and convergence in LLMs. *arXiv preprint arXiv:2510.26490*.
