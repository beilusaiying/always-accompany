# Chapter 1: Design Philosophy and Conceptual Framework

## Abstract

This chapter presents the design philosophy and conceptual framework of the P1 self-driven system. P1 is a core subsystem within the always-accompany project, whose functional role can be summarized as an **externalized chain of divergent thinking**: that is, an additional processing stage dedicated to "divergence" outside the large language model (LLM), enabling the model to perceive an entire framework of possibilities before converging to generate an answer. This chapter addresses two fundamental questions -- why P1 was designed (design motivation and convictions), and what concepts P1 uses to describe itself (conceptual framework). The chapter is organized as follows: design motivation (1.2), sources of design thinking (1.3), three-stage mechanism overview (1.4), core conceptual framework (1.5), terminology conventions (1.6), and summary (1.7).

---

## 1.1 Introduction

The mainstream development direction of current large language models is concentrated on expanding context windows (e.g., million-token contexts) and enhancing multimodal capabilities. The designer of this system holds a fundamentally different judgment regarding this direction: what the industry truly neglects is not the capacity of context, but **the allocation of attention** and **whether models can actively diverge**. Based on this judgment, P1 attempts to reverse the processing direction -- instead of requiring the model to filter a single focal point from a massive context and then converge to generate, it starts from a clear anchor, first diverges outward into an entire field of related possibilities, and then converges these into directional hints useful for generation.

To enable readers without project background to follow the subsequent argumentation, this chapter provides a concise definition at the first use of every coined term. Three foundational concepts that pervade the entire chapter require advance explanation:

- **Divergence**: the process of expanding outward from an anchor (a word, a context fragment, or a memory entry) into multiple related but not entirely identical directions or associations. It corresponds to the human cognitive act of "from this to that, extrapolating from one to many."
- **Contraction**: the opposite of divergence -- the process of aggregating, filtering, and distilling a large set of candidate information into a small number of meaningful conclusions. The generation process of large language models is essentially a form of contraction.
- **Anchor**: the starting point of the divergence process. It is jointly constituted by the preceding memory recall and the current conversational context, constraining divergence and preventing it from drifting off topic.

Additionally, the runtime status of this system must be declared. P1's self-driven processing flow and the memory-ontology recall flow are currently in **component status**: algorithms and components have been implemented, but have been temporarily removed from the production real-time pipeline; real-time retrieval is instead handled by the model's preset mechanism. What this chapter describes is the design philosophy and algorithms of this implemented component library awaiting reconnection, not the runtime behavior of the current production real-time pipeline.

---

## 1.2 Design Motivation: Three Core Judgments

P1 was not a feature added on a whim; rather, it is founded on three fundamental judgments held by the designer regarding the current direction of AI development. These three judgments are logically linked, each determining, respectively, the necessity of P1's existence, its overall architecture, and its implementation methodology. Their logical relationship is:

> Judgment One (the industry's direction is reversed) determines the necessity of P1's existence -- the model itself cannot diverge;
> Judgment Two (LLMs are contraction machines) determines P1's architectural form -- divergence must be implemented as an external node;
> Judgment Three (from concrete to abstract) determines P1's implementation methodology -- multi-axis geometric computation rather than lookup-table matching.

### 1.2.1 Judgment One: The Industry's Direction Has Been Reversed

The designer contends that the industry's current pursuit of "making context larger" (ultra-long context, multimodality) precisely sidesteps two more fundamental problems: the attention problem and the divergence capability problem. The designer's proposition is to reverse the processing direction -- no longer "find a single point from hundreds of thousands of tokens of context and then converge and diverge," but rather "start from a single point and diverge." In other words, the goal of this system is to shift the model's attention from **global** to **local**: replacing large context plus global attention with small anchor plus local attention.

This yields a set of directional contrasts. The industry mainstream tends toward large context, model-internal contraction, global top-down processing of all information, and delegation of the entire task to the model as a black box; this system instead advocates small anchor plus local attention, externally forced divergence, anchor-based bottom-up local expansion, and making the divergence stage an observable white-box node. It should be noted that the technical contrasts of "global/local," "top-down/bottom-up," and "black-box/white-box" are engineering translations of the designer's original intent of "from global to local," intended to help readers locate the differences, and are not the original formulation itself.

As a direct embodiment of the design philosophy, the designer's original formulation of this judgment is as follows:

> "My view on current AI development is completely the opposite. Everyone is chasing 1M context and multimodality, but nobody has noticed the attention problem, nobody has noticed whether [models] can diverge. ... The point is to change from finding a single point from tens or hundreds of thousands of tokens of context and then contracting and diverging, to diverging from a single point." (Designer's original words)

During development, this judgment repeatedly manifested as corrections to the tendency to "simplify and flatten the design into a linear structure." The designer repeatedly emphasized that P1's spatiality and multi-dimensionality should not be reduced to a single route.

### 1.2.2 Judgment Two: LLMs Are Contraction Machines

The second judgment establishes the architectural inevitability of P1: since large language models are inherently capable only of contraction, divergence capability **must be implemented externally** and cannot be expected to emerge spontaneously within the model. The designer repeatedly used the condensed formulation "LLMs are contraction machines; divergence must be externally attached" to summarize this point, and further characterized P1 as "a divergence node forcibly inserted outside the model," rather than "a bypass for finding content."

From a technical perspective, the following interpretation can be offered (this interpretation is an engineering translation, not the original formulation): the self-attention mechanism of large language models is essentially a competitive normalization whose effect is to contract attention into a distribution; P1's design runs in the opposite direction -- first performing input segmentation and integration (contraction), then multi-axis expansion (divergence, the stage the model itself has difficulty performing), and finally re-contracting through a merge gate.

This judgment also implies P1's role definition: the main model is like a lead surgeon whose attention is limited and who cannot exhaustively verify every possibility in the background; P1 assumes this "attention outsourcing" function, pre-scanning the possibilities that the main model has no bandwidth to consider. The designer's original formulation is as follows:

> "The AI cannot possibly spread too much attention to verify and calculate the lives of hundreds of AI characters in the background overnight, but P1 can perform divergence." (Designer's original words)

### 1.2.3 Judgment Three: From Concrete to Abstract

The third judgment prescribes P1's implementation methodology. During development, the designer provided a large number of concrete examples (medicine, games, idioms, technical terminology, etc.); these are **raw material and phenomena**. The system implementer's task is to reverse-engineer multiple computable dimensions (axes) from these materials, rather than to hardcode the examples themselves as lookup rules. The designer summarized this direction as: abstracting human language and expression into multi-axis algorithms that integrate linguistics, logic, and psychology, combined with specific scenarios and context.

The core distinction in this methodology lies between "building algorithms" and "writing prompts": the designer emphasized that what this system must build is observable, controllable algorithms; prompts serve only as analogies to aid understanding, not as the implementation itself. The accompanying data collection strategy is: prioritize extraction of dimensions from high-quality corpora such as idioms, poetry, proverbs, stories, and literature, supplemented by everyday social language -- quality first, everyday second.

The designer simultaneously provided explicit criticism of practices violating this methodology, characterizing approaches such as "drawing conclusions solely from documentation without examining actual data" and "copying raw material directly into rules" as detached from reality. This critique is also the intellectual root of the entire project's working principle of "taking actual output and actual code as the ground truth."

---

## 1.3 Sources of Design Thinking

This section traces the intellectual sources of P1's divergence concept. Most of these sources originate from the designer's observation of their own cognitive processes and cross-domain analogies, and they are essential background for understanding "why P1 was designed this way."

### 1.3.1 The "Contraction--Divergence--Contraction" Rhythm of Human Cognition

The initial inspiration for P1's three-stage mechanism came from the designer's observation of their own thought processes: when a person sees "water," they first associate it with "drowning" -- a past memory (experiential contraction) -- then diverge to related directions such as "safety, recreation, boating," and finally contract to an action judgment. From this, the designer concluded that human arbitration and processing generally follow a "contraction--divergence--re-contraction" rhythm.

It is worth emphasizing that this mechanism was not a case of "having the algorithm first and then finding a metaphor," but rather "first observing the real cycle of human cognition, then engineering it." P1's three-stage structure is, in essence, the code-externalization of this "seeing water" thought rhythm.

### 1.3.2 Observation of One's Own Thinking: Framework First, Then Diverge

The designer further noted that the true purpose of divergence is "to enable the main model to proceed to the next step of thinking, rather than being stuck at a single point," while contraction is about incorporating relevant memories as broadly as possible. The typical sequence of human problem-solving is: first mentally reviewing a framework, then diverging, then aggregating. The designer offered three concrete source examples from personal experience:

1. **Divergence during code optimization** -- starting from a minor optimization point and associating to other optimizable locations within the framework;
2. **Divergence during writing** -- referencing works and plots of the same genre and considering how to improve;
3. **Divergence from professional background** -- constructing lines of thought based on professional knowledge (e.g., psychology).

### 1.3.3 Butterfly Effect and "Radar-Style Scanning": The Error-Prevention Function of Divergence

The designer positioned one important function of divergence as **error prevention** and **framework-mapping reminders**. Three images illustrate this: first, the "butterfly effect" -- diverging from a small matter to optimization of the entire framework system; second, "human radar" -- a rapid, summarizing association that quickly sweeps through a circle of possibilities; third, "code-pitfall early warning" -- when receiving a programming task, proactively diverging to anticipate potential errors and traps to avoid.

The designer also demonstrated the form of divergence through concrete scenarios. For example, in interactive narrative scenarios, when choosing to "attack an NPC" or "interact with an NPC," divergence words could be vocabulary from similar narrative plots (e.g., nurturing, affinity, friendly interaction); in programming scenarios, if the intent is "add a front-end feature," divergence would point to related technical vocabulary (back-end, pseudo-links, etc.), serving as a professional reminder.

### 1.3.4 The "Guide NPC" Case: Concretizing Creativity

The designer used a personally experienced case to illustrate how P1 performs "divergent verification" on behalf of the model: in an interactive narrative, an NPC who had previously helped the player find directions was reused by the model several turns later to lure the player to a wrong location for a robbery. This kind of echoing reversal is precisely an expression of **creativity**. The designer used this to argue that the main model's attention is limited and cannot exhaustively verify the complete settings of hundreds of characters in the background, while P1 can pre-diverge such possibilities.

Around this line of thinking, the designer enumerated five real divergence scenarios: a small matter triggering system-wide optimization (butterfly effect), error prevention for programming tasks, judgment about NPC reuse in interactive narratives, creative reversal in interactive narratives (the robbery case above), and code reminders combining past error experience. Together, these scenarios delineate P1's positioning of "see the framework first, then think."

### 1.3.5 Mendeleev and Astronomical Inference: The Meta-Methodology of Divergence Plus Self-Learning

The designer used as examples Mendeleev's inference of unknown elements from periodic patterns without experimental technology, and astronomers' inference of undiscovered galaxies from orbital perturbations, to illustrate that P1 should possess a "divergence plus self-learning" capability: from the structural regularities of known dimensions, infer missing word classes or dimensions. The corresponding cross-domain mappings are: from "predicting unknown elements from the structural regularities of known elements" to "predicting missing word classes from dimensional gaps"; from "inferring unknown celestial bodies from anomalous perturbations" to "inferring missing dimensions from data anomalies."

A clarification is needed: this capability points to P1's lexicon gap detection and self-learning direction, not to the preceding memory recall stage; the two should not be confused.

### 1.3.6 Stable "Flashes of Insight" and Six Degrees of Separation

The designer's expectation for divergence quality can be summarized as "a flash of insight, but well-grounded." This quality had occasionally appeared in the output of certain early reasoning models, but was unstable; P1's goal is to stably engineer this quality. "A flash of insight, but well-grounded" thereby became the overarching criterion for evaluating divergence quality across the entire project.

Regarding the generation mechanism of divergence paths, the designer introduced the concept of **six degrees of separation** as a theoretical source: between any two people in the world, a connection necessarily exists through approximately five intermediaries; correspondingly, divergence requires not only same-domain expansion but also rewards for cross-domain analogy. In practice, the designer proactively simplified the path hop count to approximately two to three hops, and stipulated that when the connection strength of subsequent hops is too small, the process should automatically stop. The "five intermediaries" and "simplified to two to three hops" here are mechanism-level magnitude descriptions provided by the designer, falling within the scope of algorithm parameters; the specific decay coefficients and hop-count limits in the code are initial defaults that have not been systematically tuned.

### 1.3.7 Injection of Professional Background: From Domain Knowledge to "Small Vocabulary Activating Large Modules"

The designer's professional background (medicine) directly influenced P1's design, externalized in two specific mechanisms.

The first is the prompting technique of **"small vocabulary activating large modules"**: when constructing prompts, the designer habitually uses a single domain-specific term to activate the model's corresponding knowledge block -- as long as the model's relevant knowledge base is activated and combined with type filtering, ideal output is often obtained. This is the direct source of the "direction word seed" design concept: a single technical term (seed) is sufficient to activate an entire knowledge block within the main model.

The second is **differential-diagnostic thinking as an implicit architecture**. The designer once used a seven-step medical case-study process to analogize P1's processing: chief-complaint collection corresponds to input tokenization; multi-system parallel examination corresponds to each axis running independently in parallel; syndrome identification corresponds to spatial voting to determine anchors followed by divergence from anchors; differential diagnosis corresponds to the method of exclusion (listing all possible directions and excluding impossible ones, rather than "finding the most similar"); targeted investigation corresponds to directed divergence (targeted rather than exhaustive across the entire library); directed divergence after contraction corresponds to temperature diffusion; working diagnosis corresponds to direction word output (providing direction, not conclusions); iterative correction corresponds to hot-swapping of mechanisms. This "differential diagnosis -- syndrome pattern -- treatment method" structure was mapped to P1's "multi-dimensional collection -- spatial positioning -- direction selection," forming one of the intellectual sources of its spatial mechanism.

### 1.3.8 Other Cross-Domain Mapping Templates

During the design process, the designer also manually deconstructed multiple sets of cross-domain mappings as reference paths for P1's analogical divergence. Representative examples include: mapping drug polymorphism to model training stability (different stable states of the same substance correspond to different loss basins of the same data); mapping protein folding to model architecture design (chain to shape to lock-and-key corresponds to parameters to architecture to feature alignment); mapping input-method lexicons to P1 lexicon self-learning (high-frequency word promotion plus user-defined words corresponds to high-frequency direction word promotion plus user adaptation); mapping regular expressions to memory trigger mechanisms (specific pattern matching corresponds to fragment hooks pulling out an entire memory chain); mapping open-world games and their mod ecosystems to product positioning (framework plus plugins plus community lexicons).

From these templates, three characteristics of the designer's cross-domain leaping path can be inductively identified: first, **entering through failure modes** -- not from success cases, but from "how two domains each fail" to find isomorphisms; second, **arriving at abstract concepts from concrete bodily experience** -- using bodily and everyday experience to understand abstract systems; third, **identifying structural isomorphisms** -- what is detected is isomorphism of relational skeletons, not surface-level similarity of vocabulary.

---

## 1.4 Three-Stage Mechanism Overview: Contraction--Divergence--Contraction

P1's complete structure is a three-stage "contraction--divergence--contraction" pattern, not a linear pipeline. This is the most stable skeleton of the system, never overturned from inception through the present. The three stages function as follows:

- **Stage One (Contraction)**: First retrieves historical entries relevant to the current conversation, providing the model with dynamic context and an awareness of the overall framework; important entries change dynamically with the conversation content. This stage combines approximately the most recent six messages of context (including both user and model utterances) to mitigate context-absence issues. The "approximately six" here is a mechanism-level magnitude given by the designer, not a fixed constant.
- **Stage Two (Divergence)**: Using the anchor established in Stage One, diverges in combination with the context, simulating human lexical association. An external semantic association resource (hereafter referred to as the association network) is introduced here as the divergence source.
- **Stage Three (Contraction)**: Extracts and converts the nouns produced by divergence into meaningful content -- namely, technical terminology; in interactive narrative scenarios, this manifests as scene names, literary expressions, or writing vocabulary. The product of this stage is used to **provide direction to the main model**.

In a more detailed formulation elsewhere, the designer supplemented three points: Stage One recalls "compressed data, i.e., sentences," not entire original passages, and its function is to constitute dynamic context plus emphasis; before divergence, the input must first pass through context and attention mechanism (QKV) processing; the product of Stage Three contraction is "technical terms, works, or fragment words," whose sole purpose is to point the main model in a direction.

The designer repeatedly emphasized the **contraction-before-divergence** ordering, which provides anchors for divergence and prevents excessive drift: first look back, then perform the more difficult divergence; first contract, then diverge based on contraction results, thereby preventing drift. This principle is architecturally fixed as the serial constraint of "association first, analogy second."

A widespread misunderstanding must be corrected: there was once a claim that P1's Stage Three does not perform contraction but instead outputs signals with mechanism labels. This contradicts the three-stage structure and is incorrect. The designer explicitly stated that Stage Three "finally contracts again, extracting word properties and converting them into technical terms" -- **P1's Stage Three does perform contraction**.

Beyond the three-stage structure, there exists an **optional enhancement layer** (hereafter referred to as the enhancement layer). Its trigger conditions are unstable divergence quality or manual activation by the user; its function is to strengthen divergence, perform logical review of contracted content, and determine "whether more memories need to be read." The designer explicitly stated that the current main battleground is the self-driven P1 (not dependent on LLMs, with pure algorithms as the primary force), and the enhancement layer is a posterior supplementary capability.

---

## 1.5 Core Conceptual Framework

This section defines P1's core concepts one by one. Dependencies exist among the concepts, and sequential reading is recommended. To aid readers with zero background, every coined term is defined at its first occurrence.

### 1.5.1 Recall Is the Starting Point of Divergence

- **Recall**: the process of retrieving historical content relevant to the current conversation from the memory store; its results, together with the current context, jointly constitute the anchor for divergence.

The designer noted that the recalled content plus the current context is precisely the critical starting point of divergence; with this starting point, divergence will not go astray. Recall is not an optional auxiliary but rather the anchor starting point of divergence -- this is simply a different phrasing of "contract before diverging to prevent drift."

A boundary must be drawn here: not all "retrieval of historical information" counts as anchor recall for divergence. Retrieval of user historical preferences belongs to context recall and is not itself divergence; while the two tasks of "proactively diverging errors and pitfalls" and "historical error reminders" fall under the responsibility of recall, not divergence.

### 1.5.2 Divergence Reads Only Context, Not the Data Layer

- **Data layer**: the memory data ontology stored in tiered layers (hot, warm, cold) within the memory system.

The designer explicitly stipulated that the recall stage reads the data layer, but the **divergence stage examines only approximately six sentences of context and does not directly read the data layer**. This creates a clear division of labor -- recall is responsible for transforming the data layer into anchors, while divergence operates only on the anchors plus context.

It should be noted that how exactly recall "provides anchors" and divergence "does not read the data layer" are precisely coordinated is an **open question** that the designer personally annotated as "requiring further discussion and positioning"; subsequent design should not hardcode conclusions at this juncture.

### 1.5.3 The Essence of Adaptation Is Recall

- **Adaptation**: the processing stage that converts the scattered, raw association words produced by divergence into technical terminology.

A key insight of the designer is that adaptation is essentially an act of **recall**, not "generation." Behind each technical term lies a large body of supporting information (metaphors, associations, etc.), and the scattered words produced by the association network serve precisely as keys to retrieve corresponding content from this inverted-index-like structure. Therefore, adaptation does not fabricate words from nothing but uses scattered words as keys to retrieve the information already stored behind them.

A clarification is needed here: the two instances of "recall" belong to different stages. What this section refers to is the inverted retrieval of "from word to information" inside the adapter; this is not the same stage as the preceding memory recall described in 1.5.1 and must not be confused.

Regarding the relationship between the adapter and related components, the designer provided the following definition: the association network serves as the core for divergence, while the adapter handles the subsequent conversion; the adapter is not a single standalone component but rather the entirety of the processing flow following association-based divergence; the scoring framework contained within it is one sub-part of the adapter, while the adapter itself is the aggregate of all conversion methods.

### 1.5.4 Spatial Mechanism and the Five-Step Standard Chain

This entry is the centerpiece of the core conceptual framework. The designer repeatedly emphasized that P1's processing "is spatial, not multiplication, not hard matching, not per-word divergence."

- **Space**: the processing paradigm of superimposing the information of all related words into a single multi-dimensional coordinate space, and determining direction through positional distribution rather than pairwise multiplication.

According to the designer's definitive formulation, the standard chain consists of five steps, in the following order:

1. **Mechanisms run in parallel and independently** -- multiple axes (mechanisms) each compute in parallel without interfering with one another;
2. **Merge into a single pool** -- place all candidates into a single pool, rather than multiplying them;
3. **Score and take the mean** -- score within the pool, and use the mean in place of the product, to suppress "catch-all terms" (see 1.5.10);
4. **Positioning** -- find each proximate axis and point, establishing spatial anchors;
5. **Diffuse along temperature** -- diffuse from the anchor to its surroundings and filter; candidates too close or too far are both excluded.

The following expands the design points supporting each of these five steps.

**Regarding "addition, not multiplication" (Steps 1--2)**: The designer emphasized that this system "is spatial additive, not linear multiplication, and not hard matching," and that its direction "has always been spatial"; candidates should be "aggregated into a single pool -- not multiplied, but rather content-distribution voting within the space." The designer repeatedly corrected the tendency to degrade processing into "following a single route" or "diverging from a single word," emphasizing that directions must spread out spatially rather than remaining at a single point.

**Regarding "merge into pool and vote" (Step 2)**: The designer advocated multi-dimensional annotation in place of conflicting single-point voting -- what is needed is multi-dimensional annotation of the entire space, not annotation of a single piece of content. One formulation: after multi-axis parallel execution, merge into a single pool; each datum's proximity to each axis in the pool determines the main direction; then diverge from the main direction to other axes, applying cross-domain distribution and axis decay.

**Regarding "take the mean" (Step 3)**: The designer explicitly stated that scoring should use the mean rather than the product -- after multi-axis scoring, take the mean, and delete those below the threshold. The root cause for taking the mean is that excessively high scores on individual axes produce "catch-all terms"; taking the mean suppresses this problem (see 1.5.10 for details).

**Regarding "positioning" (Step 4)**: Each datum's proximity to each axis within the pool determines the main direction. In the designer's example, in the phrase "grandmother passed away," psychology-related candidates are both numerous and strong, so the main direction is determined to be psychology. The designer provided only the qualitative description of "numerous and strong" for proximity, without giving a computational formula; therefore, any specific proximity formula is an unconfirmed initial setting. The designer simultaneously noted that **positioning is the difficult part, not divergence itself** -- the association network's divergence quality is already good enough and does not deviate; the problem lies precisely in the adaptation (positioning) stage.

**Regarding "temperature diffusion" (Step 5)**:

- **Temperature**: the parameter that, after anchor positioning is complete, controls the range of a "circle" of diffusion from the anchor to its surroundings; during diffusion, candidates too close have no divergence value while candidates too far will drift, so both must be filtered out.

The designer described this as "adding temperature is like a circle, diffusing to the surroundings ... too close won't do, too far won't do either; filtering is needed" -- i.e., after positioning in multi-dimensional coordinates, diffusing left and right. This is the final step of the five-step chain.

### 1.5.5 Per-Word Divergence Is Prohibited: Information-Pool Divergence

The designer laid down an ironclad rule: it is prohibited to "diverge a pile of results from a single word and then add up the divergence results of multiple words," because this is both inaccurate and produces "catch-all terms." The correct approach is **information-pool divergence** -- superimpose the information of all words into a single pool (space), and see which candidates are proximate within the pool.

The "addition" here is not addition in the arithmetic sense: the designer noted that the words output by the association network have lexical-property relationships with one another, and what should be done is "lexical-property addition" -- i.e., multi-dimensionally superimposing the information of multiple proximate words and then searching for proximate candidates, rather than processing individual words in isolation; a more precise formulation is "anything matching the corresponding numerical values can be used," i.e., selection by degree of match after information superimposition.

On this basis, the system was designed with **two rounds of divergence**: the first is "context plus association," and the second further diverges the results of "context plus association" into information words; the information words then contract into direction words (see 1.5.6 for definitions of information words and direction words).

### 1.5.6 Information Words and Direction Words

- **Information word**: an intermediate product of the divergence process -- a word carrying raw information that has not yet been contracted into a technical term.
- **Direction word**: P1's final product -- a technical term formed by contracting multiple information words, pointing toward a broad directional category, used to provide suggestions to the main model.

The designer stipulated that the relationship between the two is **many-to-one**: the correct form is "multiple information words corresponding to one direction." In early development, this was incorrectly implemented as "one information word corresponding to multiple direction words," resulting in poor relevance among direction words and a lack of penalty mechanisms. The conversion from information words to direction words is precisely the terminal contraction of the three-stage structure: extracting word properties and converting them into technical terms, works, or fragment words; that is, using the pool and space constituted by information words to select direction words, with direction words relying on information words for coarse alignment.

Regarding the nature of direction words, the designer emphasized two points. First, **direction words are suggestions to the model, not judgments about the user** -- they tell the model "potentially relevant information directions," not a determination of "what state the user may be in." Second, **direction words are seeds**: although a single technical term is small, it points to an entire knowledge tree inside the main model. For example, when the main model receives the term "deliberate practice," it automatically retrieves the corresponding complete professional framework. The value of direction words lies precisely in opening knowledge entries within the main model that the model itself has difficulty proactively opening.

Direction words have three admission criteria (personally defined by the designer): searchable, seen by the model, and having consensus meaning; academic provenance is not required.

### 1.5.7 Dead Word Criteria

- **Dead word**: a word that the main model could derive on its own merely by reading the raw text.

The designer stipulated: a word that the main model could also derive from reading the raw text is a dead word, and its P1 value is zero -- if all output consists of content the model would have thought of anyway, then that output has no value. Accordingly, the designer personally defined four categories of prohibited words: first, dead words (derivable from raw reading by the model); second, route words (containing verbs, locking in specific actions, violating the "provide direction, not routes" principle); third, diagnostic words (labeling the user, e.g., "the user may be anxious"); fourth, catch-all terms (generic words appearing at high frequency, with the occurrence threshold being an unconfirmed initial setting).

An apparently contradictory yet critical principle must be emphasized: **high-volume near-miss recall is permitted**. The designer noted that "outputting dead words is also fine -- high-volume near-miss recall is acceptable, but the direction must align with the conversation." That is, P1 does not pursue precision for every single word, but rather pursues high volume, near-miss, and correct direction; dead words can be tolerated, but the direction must not deviate.

### 1.5.8 The Substance of Divergence Output: Provide Direction, Not Routes

The designer emphasized that the output of divergence should not remain at the surface level of "words" but should land on "activation directions." If the output is merely associative vocabulary with no activation power, it is meaningless -- what prompt engineering requires is "precise activation" or effective content. The corresponding core principle is "**provide direction, not routes**": provide only direction, not specific methods; do not induce or substitute for user expression.

This point does not contradict the requirement that "the adapter outputs only words, not explanations"; the two operate at different levels. The adaptation stage does indeed output only technical vocabulary without attached explanations; but the value of these words lies not in their word form but in whether they can precisely activate the main model's knowledge blocks. Therefore, the core criterion is always "whether precise activation is achieved," not "whether they are in noun form."

### 1.5.9 Point, Line, Plane, and Volume: Geometric Concepts

The designer used a set of geometric concepts to describe P1's processing levels, whose definitions have not changed since early design:

- **Point**: a word;
- **Line**: a direction, i.e., the category of a word;
- **Plane**: a type, i.e., the actual need of the user's conversation;
- **Volume**: a multi-dimensional space, i.e., an entire conversation of the user.

In terms of the overall processing order, each conversation of the user is a "volume" (containing personal experiences, environmental causes, memories, external interference); the preceding recall, association, and information words decompose the "volume" into "planes"; direction words are "lines," used to let the main model perceive clearly; and the main model is a "point." This order follows a top-down path (volume to plane to point to line), and the designer analogized it to the processing of the human visual nervous system: first acquiring color and shape contours, then confirming what the object is. It should be noted that "point, line, plane" at the association-word level and "volume, plane, line, point" at the overall level are usages at different granularities and should not be confused.

### 1.5.10 Mechanism Parallelism

- **Mechanism parallelism**: P1's mode differentiation is achieved not by adjusting the weights of each axis, but by activating different combinations of mechanisms; each mode selects a number of the most relevant mechanisms to run in parallel, while unselected mechanisms remain completely silent.

The designer summarized this principle as "mechanisms in parallel, execution in series": conceptually the mechanisms are independent and parallel; in implementation they may execute serially. Regarding mode differentiation (conversation, interactive narrative, office work, programming, etc., each differs), the difference lies not in adjusting axis weights but in activating different combinations of mechanisms; each mode selects approximately three to five of the most relevant mechanisms to run in parallel, with the rest remaining silent. The "three to five" here is a magnitude description; the specific constants are unconfirmed initial settings.

Regarding the so-called "independent mechanism list" (e.g., scenarios, embodied cognition, metaphor, narrative, opposition, analogy, etc.), it should be noted that the formulation contains post-hoc analytical elements. The designer confirmed the removal of several independent mechanisms from the main line, changing them to be integrated with sorting, layering, and axes, rather than independently restored as multiple channels. Therefore, when citing the concept of "mechanism parallelism," the qualitative formulation "mechanisms in parallel, execution in series" should be taken as authoritative. The designer's requirement for expanding "parallelism" is "disciplines first, then distribution" -- first run in parallel by discipline, then after completion, merge and check for relevance to prevent omissions.

### 1.5.11 Catch-All Term Criteria

- **Catch-all term**: a generic word that appears frequently and is "tangentially relevant" to most contexts yet lacks specificity.

The designer's root-cause judgment of catch-all terms is: they are not "certain words that are inherently toxic and should be blacklisted," but rather a symptom of **insufficient information, insufficient axes, unstable positioning, or excessively high scores on individual axes**. The corresponding solution is to take the mean (see 1.5.4, Step 3) plus multi-axis verification plus proper positioning, rather than piling up blacklists for hard deletion. In later development, the designer further clarified: the lexicon is already sufficient; what is truly lacking is positioning -- how to effectively activate the correct direction.

This gives rise to a **soft-filtering ironclad rule**: filtering should use soft filtering, not hard filtering. Soft filtering means a word does not disappear but is demoted in weight or ranking; hard filtering means a word is directly skipped and loses any chance of being recalled -- the latter is strictly prohibited. The designer emphasized adherence to the principle of prioritization: no hard-deleting borderline words, no piling up blacklists.

### 1.5.12 Framework Identification and Cross-Framework Analogy

The designer described framework identification and cross-framework analogy as a core design they had "always wanted to build," with the quality target remaining "a flash of insight, but well-grounded." The thinking is: when humans consider a problem, they first review a framework, then diverge, then aggregate; starting from a minor optimization point, one associates to other optimizable locations within the framework; from a small matter, one diverges to optimization of the entire framework system (butterfly effect). The prerequisite for analogy is that a mappable correspondence exists between two domains -- the knowledge systems may differ, but they must be mappable or theoretically fusible. The purpose of divergence is to endow the model with a professional thinking capability that dynamically changes with the user: turning the aforementioned framework into an external thinking process, from which the model then selects effective elements and combines them. The designer equated cross-framework analogy with the aforementioned cross-domain distribution mechanism. It should be noted that in interactive narrative scenarios, this kind of cross-domain analogy carries the greatest uncertainty, and the designer recommended making it a toggleable option.

The designer drew explicit distinctions among related concepts:

- **Associative divergence**: expanding to semantic neighbors, i.e., moving among proximate meanings;
- **Analogical divergence**: extracting the relational skeleton and finding isomorphic structures in entirely different domains.

The value ranking of three types of divergence is: analogical divergence has the highest value (potentially discovering entirely new directions) and should be preferentially retained with high-score rewards; same-domain divergence has medium value -- robust but lacking breakthroughs -- retained but not prioritized; literal association (semantic neighbors or surface similarity) has the lowest value, is easily misleading, and should be preferentially filtered out. The designer emphasized that "association first, analogy second" should prevent analogy drift, and noted that extracting relational skeletons from Chinese user input is relatively difficult. The designer explicitly stated that the current system leans toward same-domain divergence, while the goal is to introduce analogical divergence and establish rewards for it.

### 1.5.13 Essential Convergence: The Product of Divergence Is Activation Direction

Synthesizing 1.5.6 through 1.5.8 and 1.5.12, the essence of P1 divergence can be distilled to a single sentence: **P1 divergence's final product is "direction word seeds," whose value lies not in word form but in whether they can precisely activate the main model's professional knowledge blocks and provide conversational direction.** This yields a complete criterion chain: if it activates, it is a good word (e.g., "deliberate practice" can invoke a complete professional framework); words the main model could derive from raw reading are dead words, with zero value; words that lock in behavior, label the user, or are catch-all terms are prohibited; high-volume near-miss recall is acceptable, but direction must align with the conversation. In other words, the function of direction words is to hint at "what lies buried beneath this utterance," pointing out latent information directions for the main model, rather than pouring content directly to the user -- this is consistent with the principle of "provide direction, not routes" in 1.5.8.

---

## 1.6 Terminology Conventions

Over the long development of this system, participating AIs created a batch of formulations, some of which were mistakenly circulated as the designer's original definitions. To prevent misattribution, this section distinguishes "AI coinages" from "designer terminology." Where this chapter's main text cites the designer's viewpoints, it has been expressed in accordance with this convention. What this section enumerates are points that external readers must be particularly careful to discern when reading related literature.

### 1.6.1 Several Frequently Misattributed Formulations

- **"The scoring framework is the divergence engine; the association network is merely its exam"**: This formulation was created by an AI. The designer's definition is "the association network serves as the core for divergence; the scoring framework serves as the adapter" -- meaning the scoring framework is the adapter, not the divergence engine, and its current implementation has only completed the sorting function and still requires further optimization.
- **"Clustering into several cognitive modules"**: This formulation is an AI original; the designer never advocated "clustering." The only time the designer mentioned "clustering" was when questioning a certain approach (asking whether it used clustering, principal component analysis, mutual information, or other statistical algorithms), which constituted criticism rather than a design proposition.
- **Metaphors such as "a certain axis is a searchlight" and "a certain catch-all term check"**: All are AI-created metaphors with no substantiation in the designer's original records.
- **"The world's first external divergence engine not dependent on LLMs"**: This formulation was created by an AI and constitutes promotional rhetoric. The designer's original formulation is "an externalized chain of divergent thinking." Whenever a single-sentence summary of P1 is needed, the latter should be used.

### 1.6.2 Understandings Confirmed as Incorrect

- The claim that "direction words are isolated islands with a broken consumption chain" is incorrect. The designer's design is "small vocabulary activating large modules": direction words as seeds need not be explicitly referenced; moreover, the main model's internal processing is outside the jurisdiction of P1.
- The claim that "P1's Stage Three does not perform contraction but outputs signals with mechanism labels" contradicts the three-stage structure and is incorrect; Stage Three does perform contraction (see 1.4).
- "Vector addition plus cosine distance" is an AI's technical translation; the designer only said "multi-dimensional addition" and did not specify cosine distance.
- Treating the spatial-positioning axes at the output end as "sub-categories" of the parallel axes at the input end is incorrect: these are different things. The input end has independently parallel axes, while the output end has a separate set of axes for spatial positioning; the two do not constitute a parent-child relationship.
- Several field names and output schemas were designed by AIs and have not been confirmed by the designer; the output confirmed by the designer is direction words.

### 1.6.3 Terms Whose Naming Attribution Requires Discernment

The following terms may point in the correct direction, but their names were coined by AIs and should not be cited as the designer's original words: "three-layer bias," "interactive-stance encoder," "addition-as-filtering," "four-stage cadence," "coordinate system naming," etc. -- all are AI integrations and namings. The designer's corresponding formulations are broader or more colloquial (e.g., expressing one item as "multi-dimensional addition and then searching" and another as "suggestions for the model"). Additionally, certain Anglicized score-item names and specific conversion mapping rules were also designed by AIs and have not been confirmed by the designer.

### 1.6.4 Two Points That Should Be Annotated as Inductions Rather Than Original Words

- "Function words are directional signals (e.g., certain adversative words indicate expectation violation; certain words indicate hierarchical correction)" is an AI induction, not the designer's verbatim formulation; the designer's verbatim content consists only of individual examples.
- Regarding the dedicated discussion of "certain modal particles having an information-intensifying function," no verbatim source was found in the designer's original records or code documentation; it appears only in examples. All related modal-particle signal tables are AI mappings within the documentation.

### 1.6.5 Value Annotation Principles

The designer established a value annotation principle that pervades all design literature: during the design phase, only algorithms and mechanisms are discussed, and no specific values are locked in; specific values appearing in the implementation layer must be individually audited for their source. Accordingly, this chapter adopts the following normative formulations for values: magnitudes appearing in the designer's original words (e.g., approximately six messages of context, six degrees simplified to two to three hops, approximately three to five mechanisms selected) are **mechanism-level magnitude descriptions** and are not confirmed as precise constants; values locked in through experimental testing in the code with clear justification are expressed as **experimentally calibrated fixed values**; values written by AIs independently without designer confirmation are expressed as **initial defaults (not systematically tuned)**. Under this principle, the large number of hardcoded values in the code should, with the exception of the few with experimental justification, all be regarded as initial defaults.

---

## 1.7 Summary

This chapter has established the design foundation of the P1 system. Its one-sentence positioning is an **externalized chain of divergent thinking**: attached to the large language model, which is only capable of contraction, is a forced-divergence processing node that enables the model to perceive the framework before converging to generate.

Three design motivations progress in logical layers: the industry's direction has been reversed, determining the necessity of P1's existence; LLMs are contraction machines, determining that divergence must be implemented as an external node; from concrete to abstract, determining that P1 adopts multi-axis geometric computation rather than lookup-table matching as its implementation path. P1's intellectual sources include observation of the human cognitive "contraction--divergence--contraction" rhythm, as well as a series of cross-domain analogies: the butterfly effect, radar-style scanning, Mendeleev's inference, six degrees of separation, and medical differential diagnosis, among others.

At the mechanism level, P1 follows a three-stage skeleton (contraction--divergence--contraction), in which the core of the divergence stage is a five-step spatial standard chain: mechanism parallelism, merge into pool, score and take the mean, positioning, and diffuse along temperature. Around this skeleton, this chapter has defined the core concepts of recall, divergence, anchor, adaptation, space, information word, direction word, dead word, point-line-plane-volume, mechanism parallelism, catch-all term, and cross-framework analogy one by one, and has clarified several pervasive principles: contract before diverging to prevent drift; addition rather than multiplication; mean rather than product; soft filtering rather than hard deletion; provide direction rather than routes; high volume and near-miss while direction does not deviate.

Finally, two boundaries must be restated. First, this chapter describes the algorithms of an implemented component library awaiting reconnection to the production pipeline; real-time retrieval in the current production pipeline is handled by the model's preset mechanism. Second, except for the few that have been experimentally calibrated, all values appearing in the literature should be regarded as initial defaults that have not been systematically tuned. P1's process framework and per-node details, algorithms and formulas, and the memory system will be expanded in subsequent chapters.
