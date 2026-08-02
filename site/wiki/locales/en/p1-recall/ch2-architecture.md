Chapter 2: System Architecture and Processing Flow

## 2. Introduction

This chapter describes the overall architecture and processing flow of the P1 Self-Driven Divergence & Recall system. P1 is an associative divergence engine that does not depend on large language model (LLM) online inference; its design goal is to provide the main conversational model, during dialogue, with a set of "direction words" -- namely, associative directions that the main model would have difficulty spontaneously conceiving by reading the raw text alone. The designer summarized P1's positioning as "an externalized chain of divergent thinking": it neither makes judgments on behalf of the main model nor generates reply content, but instead, like a visual system, pre-scans the input and sketches associative contours, handing the main model a "map with routes already marked" so that it need not begin thinking from a blank slate.

A system status clarification must be made at the outset. The complete "recall--divergence" processing chain described in this chapter is an algorithm that has been implemented within the system's component library and can be read line by line, but it is not connected to the main chain in the current live runtime path. According to design records (July 2026), the system's online word-production function is temporarily handled by an LLM-based preset retrieval mechanism (hereafter referred to as AI preset retrieval), while the self-driven divergence pipeline described in this chapter is in "component status" -- algorithms have been implemented and are awaiting reconnection to the main chain. To avoid reader confusion, when describing each processing stage, this chapter distinguishes between "design intent and algorithm implementation" and "whether currently enabled in the live pipeline"; all stages not connected to the live main chain are truthfully annotated.

This chapter is organized as follows: Section 2.1 presents the five-step standard processing chain overview, serving as the skeleton for understanding the entire flow; Section 2.2 presents the overall architecture, including the twelve-node processing diagram, three route schemes, and U-shaped injection mechanism, accompanied by explanatory text; Section 2.3 provides a specification-level description of each processing node, detailing its input, processing, output, and key parameters; Section 2.4 serves as an appendix introducing historical architectural versions (marked as historical, not the current implementation); Section 2.5 is the chapter summary.

Regarding terminology, all coined terms appearing for the first time in this chapter are first defined. To help external readers build an overall picture, several core concepts pervading the entire chapter are established here:

- **Axis**: a disciplinary perspective. The system uses six disciplinary axes as the input end of divergence; each axis independently produces a set of associative information about input words from its disciplinary perspective.
- **Plane and line**: the designer uses "plane" and "line" to distinguish the output form of an axis. If an axis produces only a single score for a word (e.g., a scalar property), it is said to output a "line"; if it produces a rich set of associated information words, it is said to output a "plane." The system requires each axis to output "planes," not "lines."
- **Pool and space**: the candidate words produced by each axis are merged into a shared collection called a "pool"; the system performs distributed aggregation and positioning on the pool contents in word-vector space, hence it is also called "space." The designer emphasized that the pool's semantics is "spatial additive" rather than "linear multiplicative."
- **Temperature**: a parameter controlling the range of divergence. The designer used the metaphor of "drawing a circle" -- diffusing a circle outward from the anchor; if the circle is too small, only synonymous redundant words are obtained; if too large, irrelevant noise is included; the appropriate interval must be filtered between the two.
- **Information word and direction word**: the system's intermediate products are "information words" (words describing content related to the input); the final products are "direction words" (associative directions for the main model's reference). The two are connected through a conversion of "information words serving as a pool from which direction words are selected."

## 2.1 Five-Step Standard Processing Chain Overview

The system's core processing flow can be summarized as a continuous cognitive chain composed of five steps: six axes and various mechanisms run in parallel, each independently; results flow into the same candidate pool; scoring is performed within the pool; the axes and positions each candidate is proximate to are determined; and finally, diffusion proceeds along temperature. These five steps are not five isolated algorithms but rather a coherent chain of "each mechanism runs independently in parallel -> merge into a single pool -> score and position within the pool -> diffuse along temperature toward the boundary." The following expands each step.

### 2.1.1 Step One: Six Axes and Mechanisms Run in Parallel, Independently

The core principle of Step One is **mechanism parallelism, not axis parallelism**. The system distinguishes two types of parallel objects: first, the six disciplinary axes each diverge independently (axis parallelism); second, several divergence mechanisms (e.g., plot, metaphor, analogy, etc.) each run independently (mechanism parallelism). The designer repeatedly emphasized that P1 employs mechanism parallelism, and that divergence should "extend along the main axis, rather than spread out independently" -- only by extending along the main axis can genuine divergence and connections form, rather than unrelated piles of vocabulary.

The six disciplinary axes constitute the system's **input end**, each diverging in parallel: psychology, informatics, sociology, logic, linguistics, and cognitive science. The "six axes including cognitive science" represents the current finalized form; the system initially adopted five fixed axes without cognitive science, which was added later. This evolutionary process is described in Section 2.4 (historical versions). The designer characterized the six axes as the "input end," explicitly distinguishing them from the positioning coordinates at the output end (see Steps Three and Four).

Each axis's divergence follows the "disciplines first, then distribution" ordering -- first producing candidates from each disciplinary perspective, then performing spatial distribution in subsequent steps. The purpose of parallelism is **preventing omissions**: after each axis has completed its own path, they merge and check for relevance, rather than mutually trimming during the process, thereby avoiding premature discarding of potentially valuable associations.

An ironclad rule pervading this step is "output planes, not lines": each disciplinary axis should output a set of associative information for each word (a "plane"), not a vague property score (a "line"). That is, the design requires each disciplinary axis to provide a set of information for each word, not a single value. Correspondingly, each disciplinary axis is equipped with its dedicated knowledge resources.

In summary, Step One can be summarized as the following pipeline: the six axes each run independently -- psychology, informatics, sociology, logic, linguistics, and cognitive science each produce their candidate word planes; these are then merged into a single pool; the degree of each datum's proximity to each axis within the pool determines the main direction (main axis); divergence then proceeds from the main direction to other axes (constrained by hop count, extending along the main axis rather than spreading flat); finally, axis decay is applied (the main axis has the highest weight, secondary and distant axes are progressively down-weighted, but only down-weighted, never deleted).

### 2.1.2 Step Two: Place into Pool (Merge into a Single Pool)

Step Two merges the output of each axis into a shared pool. The key design judgment here is: **the pool is essentially spatial superposition, not multiplication**. The designer's complete formulation is: "Aggregate into a single pool -- not multiplication, but space, performing content-distribution voting ... information words then serve as a pool and space from which direction words are selected." The system performs "spatial addition" in word-vector space, determining direction through distributed voting of content, rather than linearly multiplying scores from each path, and not through hard matching.

The semantics of entering the pool is **information superposition**. When multiple words enter the pool simultaneously (e.g., the combination of "like" and "idiot"), the system adds their content and positions their composite location in space, rather than processing them separately and taking the product.

Entering the pool follows an ironclad rule: **per-word divergence followed by addition is prohibited**. The designer explicitly opposed the approach of "diverging a pile of results from a single word and then adding up the divergence results from multiple words separately," considering it both inaccurate and the root cause of the "catch-all term" phenomenon (i.e., producing large quantities of words that are generically applicable to any input and lack specificity). The correct approach is "information-pool divergence" rather than per-word divergence -- first form the pool, then diverge from the pool as a whole.

To characterize the spatial semantics of the pool, the designer introduced a four-level "point, line, plane, volume" structure: point is vocabulary, line is direction (the category of vocabulary), plane is type (the actual need of the user's conversation), volume is multi-dimensional space. Mapped to the system structure, volume is the total space constituted by all axes, plane is the six disciplinary axes (each outputting a set of information words), line is the finer sub-direction coordinate, and point is a specific term.

### 2.1.3 Step Three: Scoring (Content-Distribution Voting)

Step Three scores candidates within the pool. The foundational principle is **spatial content-distribution voting**: a candidate's score is determined by its distribution in space, not by per-word lookup scoring. The voting direction is **many-to-one** -- multiple information words jointly point to one direction, rather than one information word pointing to multiple direction words.

Regarding "taking the mean," there is a design tension that requires clarification. On one hand, the system has the principle of "not taking the mean to preserve distributional tension"; on the other, there is the statement that "the mean should be taken when certain axes have excessively high scores." These two do not conflict because they apply to different objects (this clarification has been adjudicated in the design records):

- **Not taking the mean** applies to **inter-word vote aggregation**: when multiple paths hit the same word, votes are summed rather than averaged, to preserve distributional tension. This is a red line at the word-level mechanism layer.
- **Taking the mean** applies to **inter-axis scale calibration**: different disciplinary axes inherently produce scores in different magnitudes, and certain "large axes" with higher scores would monopolize rankings, so inter-axis scores are normalized by taking the mean. This is axis-level scale calibration.

The two apply to different objects, do not contradict each other, and coexist in the system design. Regarding the scoring aggregation method, the system employs **additive voting** rather than multiplication. Early versions used a multi-factor product scoring formula, which was identified as the root cause of the catch-all term phenomenon and was subsequently rewritten as additive aggregation. The current core form of the scoring stage is "additive voting, where vote equals weight times inverse-distance weight, with no chained multiplication and no division by path count"; algorithm details are in the corresponding node in Section 2.3.

### 2.1.4 Step Four: Find Proximate Axes and Positions (Near-Axis Attribution and Point Positioning)

Step Four completes directional positioning within the pool, comprising two actions: determining proximate axes and positioning points in fine-grained space.

**Near-axis attribution** means: after projecting the pool's information into the fine sub-direction space, finding the approximately three to five most proximate axes, then applying decay and divergence to these axes, converting information words to direction words, and outputting them. The designer emphasized that the fine sub-direction space is "originally activated, not entirely enabled" -- only sub-directions relevant to the current input are activated, rather than exhaustively traversing all of them.

The basis for determining the main direction is **proximity** -- the degree of each datum's proximity to each axis within the pool determines the main direction. For example, when the input is "grandmother passed away," psychology-related candidates in the pool are numerous and strong, so the main direction is determined to be psychology; when the input involves technical programming content, informatics candidates dominate the pool, and the main direction is informatics. The designer did not provide a specific mathematical formula for proximity; the system's implementation approximates it by "counting cumulative votes per axis after voting to determine the main axis."

The system distinguishes two sets of axes: the six disciplinary axes are responsible for **determining the divergence point** (input end), while the fine sub-direction space is responsible for **approximate positioning, expansion, and output** (output end). The two are not the same thing, and the fine sub-directions are not subordinate sub-categories of the six disciplinary axes. The designer noted that the design of the fine sub-direction space is not yet mature, while the six-axis division is sound.

**Point positioning** employs multi-dimensional coordinates plus anchor density: positioning via multi-dimensional coordinates, then diffusing left and right with temperature. The analogy is: first determining the anchor position through spatial voting of multi-word combinations (similar to combinatorial pattern recognition of syndrome groups), then diffusing from the anchor in a circular pattern using temperature.

### 2.1.5 Step Five: Diffuse Along Temperature

Step Five diffuses outward from the anchor along temperature to obtain the final divergence boundary. Its core design is: temperature defines a circle centered on the anchor; candidates diffuse to the surroundings; both too close and too far are unacceptable and must be filtered. The specific breakdown is:

- **"Too close"** is the circle's inner boundary, used to filter out dead words and synonymous redundancy (words too close to the anchor are often ones the main model could think of on its own and lack divergence value).
- **"Too far"** is the circle's outer boundary, used to exclude irrelevant noise.
- **The middle interval** is the "sweet spot" to be retained.

The criterion for "too close" is supported by the "dead word" concept: words the main model could also derive by reading the raw text are dead words, and P1's value lies precisely in providing directions the main model cannot think of on its own.

The designer explicitly distinguished three easily confused concepts: **decay** refers to directed divergence, not exhaustive traversal of the entire library (targeted, not exhaustive); **temperature** refers to the directed diffusion range after sub-direction space contraction; **hot-swapping mechanism** refers to iterative self-learning correction, which is neither temperature nor decay. The three must not be conflated.

Regarding **decay**, the design principle is "apply when involving other axes, but with decay, without affecting the main force." The system's implementation uses tiered decay: the main axis has the highest weight, secondary and distant axes are progressively reduced, but distant-axis weights never reach zero (only down-weighted, never deleted), achieving "soft isolation."

Regarding **diffusion stopping conditions**, the system uses hop-count constraints (constrained to within a few hops) combined with axis decay. Additionally, there is an experimentally derived distance red line: the distance of associative divergence must be maintained in the mid-to-long range; the shortest distance (synonymous expansion) is a prohibited item -- experiments demonstrated that degrading divergence to synonymous expansion caused recall quality to drop drastically (by approximately 70% in one benchmark), so this item has been locked as prohibited.

It should be noted that one specific implementation of the "too close" inner boundary was removed because its threshold lacked justification (see the known issues of the corresponding node in Section 2.3). Currently, part of the "too close" function is handled by the sweet-spot decay logic in later-stage nodes, so the chain is not completely broken.

### 2.1.6 Correspondence Between the Five Steps and Nodes

The five steps of the standard processing chain correspond to the specific processing nodes described in Section 2.3 as follows:

| Standard Chain Step | Corresponding Node | Core Design Principle |
|---|---|---|
| (1) Six axes and mechanisms run in parallel, independently | Node 3 (six axes output planes) | Disciplines first, then distribution; six axes as input end each diverge in parallel |
| (2) Place into pool | Node 6, first invocation (information pool) | Aggregate into a single pool -- not multiplication, but space |
| (3) Scoring | Node 6 spatial voting + Node 8 scoring framework | Content-distribution voting; inter-axis scale calibration takes the mean |
| (4) Find proximate axes and positions | Node 4 (sub-direction activation) + Node 9 | Find the most proximate axes; proximity determines the main direction |
| (5) Diffuse along temperature | Node 6 temperature circle + Node 7 second divergence | Draw a circle with temperature; filter out both too-close and too-far |
| Output direction words | Node 9 -> Node 10 | Information words serve as a pool; direction words are selected in space |

## 2.2 Overall Architecture

### 2.2.1 Twelve-Node Processing Diagram

The system's current implementation is orchestrated by a node pipeline (module identifier `p1_pipeline.mjs`, which handles the sequential orchestration of each node). The complete processing chain runs from user input to direction-word XML injection; the node structure is as follows. For readability, this is expressed as an ASCII diagram, followed by a node-function commentary.

```
User's current input (raw text)
   |
   +------------------------------+
   v                              v
[Step-1] Bracket dual-channel    [Node 0] Memory recall (P1 function 1)
Pre-tokenization recognition     Context + association + algorithm -> data/hot/cold layers
of () metalanguage symbols       High-volume near-miss recall (parallel with tokenization,
Main/sub channels processed        serving as divergence anchor)
separately; no mean taken
to preserve tension
   | (main channel to tokenizer)   | (anchors merge into scatter-word pool)
   v                              |
[Node 1] Contraction-1 <---------+
Tokenization + exclude dead words
(degree adverbs/polarity words retained as intensification signals)
   |
   v
[Node 2] Divergence-1 (P1 function 2)
Associative divergence -> scatter-word pool
(Divergence distance must stay mid-to-long range; synonymous close-range expansion prohibited)
   |
   v
[Node 3] Six-axis independent parallel divergence (6+n)
Psychology / Informatics / Sociology / Logic / Linguistics / Cognitive Science
Each outputs "planes" not "lines" -> merge into a single pool
   |
   v
[Node 4] Sub-direction space refinement + 300-dim word vectors
Positioning in fine sub-direction space (activated, not all)
   |
   v
[Node 5] * Operator: resource-library multi-resource positioning refinement
ConceptNet / commonsense KB / CiLin / synonyms, etc. (reusable at multiple points)
Produces only confirmation signals; does not modify coordinates
   |
   v
[Node 6] Aggregate into a single pool -> space
Content-distribution voting -> draw circle with temperature (boundary)
* No multiplication - spatial additive - match inside circle, exclude outside
   |
   v
[Node 7] Diverge information words (second divergence)
Cross-domain + upstream/downstream flow + attribution + analogy (multi-path)
   |
   v
[Node 8] Scoring framework + filtering-1
Filter information words (down-weight catch-all terms / noise / redundancy)
   |
   v
[Node 9] Information words as pool -> space -> direction words
Many-to-one voting (sole word-output path)
   |
   v
[Node 10] Scoring + filtering-2 -> output
Exclude dead words / route words / diagnostic words / subjective words (hard removal)
   |
   v
<Direction word XML> -> inject into main model

(Pervasive throughout: * Hot-swappable self-learning mechanism - * White-box observability mechanism)
```

**Node function overview**: The processing chain starts with two parallel entry points -- Step-1 identifies the bracket metalanguage symbol before tokenization, splitting the content inside and outside brackets into main and sub-channels for separate processing; Node 0, in parallel with tokenization, performs high-volume memory recall, with the recall results serving as anchors for subsequent divergence. The main channel passes through Node 1 for tokenization and contraction, then Node 2 for associative divergence to form a scatter-word pool, entering Node 3's six disciplinary axes for parallel divergence. Node 4 performs positioning in the fine sub-direction space; Node 5, as a reusable "operator," uses the resource library for cross-confirmation of candidates. Node 6 is the core of the entire chain, merging candidates into a single space, performing content-distribution voting, and drawing a circle with temperature to define the boundary. Node 7 performs a second divergence to expand information words; Node 8 scores and filters information words. Node 9 takes the information words as a whole pool and selects direction words in space -- this is the sole word-output path. Node 10 performs final filtering and hard-removes prohibited words, outputting the direction-word XML for injection into the main model. The hot-swappable self-learning and white-box observability mechanisms pervade the entire process (see 2.3.13 and 2.3.14).

The "* operator" annotation (Node 5) in the diagram indicates that this node is not a one-time fixed step in the chain but rather a positioning-refinement operator reusable at multiple points; the two "*"-annotated mechanisms are support mechanisms that cut across the entire flow, not links in the serial chain.

### 2.2.2 Three Route Schemes (Position of the LLM Optimizer)

The system's design reserves three routes, differing only in **where the LLM optimizer is inserted**. The LLM's role here is strictly limited to "optimizer of direction, header, and conversion words," not a source of divergence, and is constrained by four red lines (see below). The foundational divergence engine is the same across all three routes; the difference lies in whether an LLM is introduced and at what point:

- **Route 1 (basic, no LLM)**: Performs memory recall and high-volume near-miss recall based on the conversation, then performs the first associative divergence based on context, followed by adapter conversion and re-divergence. No LLM is introduced throughout.
- **Route 2 (LLM before associative divergence)**: After memory recall and near-miss recall, the LLM first assesses overall direction, header, secondary divergence targets, multi-head, possible typos or hidden content, and contextual logic, then associative divergence is performed, followed by adapter conversion.
- **Route 3 (LLM after associative divergence)**: First performs memory recall, near-miss recall, and the first associative divergence, then the LLM, based on context and divergence output, optimizes header, direction, key conversion words, secondary directions, and assists in identifying typos or hidden content, followed by adapter conversion.
- **Route C (dual-position)**: The LLM intervenes at both of the above positions; this is a planned testing direction.

The three routes in ASCII diagram (where "implemented" indicates the corresponding stage has been implemented, and "experimental" indicates implementation in an experimental branch but not yet merged into the main chain):

```
                  User dialogue input
                       |
                       v
             Memory recall (high-volume near-miss)
                       |
                       v
                  Context integration
        +--------------+--------------+
        v              v              v
   [Route 1 Basic]  [Route 2 A-path] [Route 3 B-path]
   No LLM           LLM before        LLM after
                     divergence        divergence
        |              |              |
   Associative      LLM sees overall  Associative
   divergence       (experimental)    divergence
   (implemented)       |              (implemented)
        |           Inject config,       |
   Adapter          then associative  LLM per-word
   re-divergence    divergence        annotation
   (implemented)    (implemented)     (experimental)
        |              |                 |
        |           LLM post-process  Weight
        |           up/down-weight    modification
        |           (experimental)    (experimental)
        |              |                 |
        |           Second divergence Second divergence
        |           (experimental)    (experimental)
        |              |                 |
        v           Adapter           Adapter
    XML output      (implemented)     (implemented)
                       |                 |
                       v                 v
                  XML output         XML output
```

Regarding the **implementation status** of the three routes: Route 1 is essentially implemented (no LLM, production path only); the LLM stages of Routes 2 and 3 have been fully implemented in the experimental branch but have not been merged into the main chain and are in conditional-activation status; Route C, as the dual-position scheme, has the lowest implementation level. One critical broken link is: the pathway for feeding LLM output back to the adapter has not yet been connected -- the mapping from LLM results to second divergence has been written within the experimental branch, but the main chain does not yet consume LLM results. It should be emphasized that this three-route scheme is a design and code snapshot from the system's early monolithic architecture era; the current pipeline architecture's live word production follows Route 1 (no LLM branch); LLM integration has its own subsequent version evolution and is in component status.

**Four red lines for the LLM**: Within the system, the LLM is positioned as a "label generator" rather than a "labeling expert" (the latter would introduce uncontrolled creativity). Its four absolutely inviolable constraints are: no creation (output is primarily based on raw text and recalled content, with only a minimal proportion from closed enumerations); no scoring (no numerical fields are produced); no projection (no speculation about content the user has not stated); no system impact (its output is labeling, not modification of the main chain).

### 2.2.3 P1's Position in the Dialogue Flow

P1's position in the overall dialogue processing flow is as follows. During the prompt acquisition phase, the system sequentially loads memory data, determines the current mode, injects table data, injects hot-layer memory, and injects the prompt chain; it then enters the P1 self-driven cognitive divergence stage (executed asynchronously, not blocking the main flow), and finally performs mode-specific injection and web search. After the P1 stage, the main model generates a reply, which is then processed by the subsequent archiving and memory migration pipeline.

```
User input
  |
  v
Prompt acquisition phase
  +-- 1. Load memory data
  +-- 2. Determine current mode (conversation/code/work)
  +-- 3. Table data injection
  +-- 4. Hot-layer memory injection
  +-- 5. Inject prompt chain
  +-- 6. P1 self-driven cognitive divergence (async, non-blocking)   <- P1 is here
  |    -> Design: output direction-word XML when confidence reaches threshold
  |    -> Design: fall back to AI preset retrieval when confidence is insufficient
  |    -> Current live: self-driven sufficiency check is always false; always goes to AI preset retrieval
  +-- 7. Mode-specific hot-layer injection
  +-- 8. Web search (triggered when P1 output contains a search hint)
  v
Main model generates reply
  v
Reply processing -> archiving -> end-of-day cleanup -> tier migration -> periodic cleanup
```

The annotation "Current live: self-driven sufficiency check is always false" in the diagram corresponds to the system status declaration at the beginning of this chapter -- the live main chain always goes to AI preset retrieval; the self-driven divergence chain described in this chapter is a component-status implementation awaiting reconnection.

### 2.2.4 U-Shaped Injection Mechanism

When P1's output is injected into the main model, it employs **U-shaped injection** -- i.e., based on the primacy and recency effects of attention, the most important content is placed at the beginning and end of the sequence, with the weakest content in the middle. Injection is layered by depth:

```
Depth 2 -> API cache zone (cross-turn stable)
Depth 1 -> System prompt zone (cache-friendly)
Depth 0 -> Dialogue tail (strongest attention)  <- P1 direction-word XML injected here
          +-- Cognitive activation block (by mode: conversation/code/work/specific scenario)
          |    Contains cognitive terms / direction words / technical signals / extensions / anchors
          +-- In-memory dynamic data
```

The P1 direction-word XML is injected at depth 0 (dialogue tail, where attention is strongest). Within the direction-word XML itself, a U-shaped arrangement is also applied: the top-ranked direction word is placed first (primacy effect), the second-ranked is placed last (recency effect), and the third-ranked -- the relatively weakest -- is placed in the middle (weakest position). The various components of the entire XML block are also arranged according to this principle, with recalled memories at the beginning and direction words at the end.

## 2.3 Per-Node Specification Descriptions

This section provides a specification-level description of each processing node, one by one. Each node is expanded across five layers: "design principle -> processing mechanism -> current implementation -> key parameters -> known issues." The code implementations of each node reside in the P1 subdirectory of the system's memory module, with node modules named `p1_node*.mjs`; module names are retained in the descriptions as functional identifiers. All stages not connected to the live main chain are truthfully annotated in "known issues." In parameter annotations, "experimentally calibrated fixed value" refers to a value established by experiment, while "initial default (not systematically tuned)" refers to a value without experimental justification.

### 2.3.1 Step-1: Bracket Dual-Channel (Pre-Tokenization Layer)

- **Design principle**: Brackets are a metalanguage symbol; P1 must identify brackets before tokenization, processing the main channel (body text) and sub-channel (bracket content) separately; otherwise, genuine emotions will be lost. The sub-channel often carries genuine emotions not stated in the body text.
- **Processing mechanism**: Before all algorithms and prior to tokenization, brackets are identified and split into main and sub-channels. The two are processed separately, and **the mean is not taken; tension is preserved** (when emotions in the body text and brackets are directionally opposed, taking the mean would cancel them out). Formatting-purpose brackets such as serial numbers and marginal notes are exempted. When no brackets are present, the single-channel path is followed with zero additional overhead.
- **Current implementation**: Module `p1_step1_bracket.mjs` provides bracket channel-splitting functionality, returning the main channel, sub-channel, and a flag indicating whether brackets are present. The sub-channel runs an additional round of divergence; the two pools are merged via set union (no mean taken); main and sub scatter words jointly enter spatial voting, so opposing emotions do not cancel out. When no brackets are present, the entire step is skipped.
- **Key parameters**: The bracket dual-channel switch is enabled by default.
- **Known issues**: None. This stage is in usable status within the component library.

### 2.3.2 Node 0: Memory Recall (P1 Function 1, Parallel with Tokenization)

- **Design principle**: Recall is the primary task; P1's function is recall plus divergence. The system uses a look-back mechanism, combining context, attention concentration, and multi-axis perspectives, to review prior content (data layer, hot layer, cold layer), match and retrieve it, and inform the main model; this process does not require highly intelligent judgment. The designer explicitly drew the boundary between recall and divergence: recall reads the memory data layer, while divergence itself only examines the most recent few sentences of context and does not read the recalled data.
- **Processing mechanism**: Using the most recent several messages of context plus association plus algorithms, examines the three tiers of compressed memory (data/hot/cold), performs keyword and information matching, and conducts **high-volume near-miss recall**; the results serve as divergence anchors. Recall runs in parallel with tokenization; divergence only examines recent context and does not read recalled data.
- **Current implementation** (two independent lines must be distinguished):
  - Module `p1_node0_recall.mjs` provides **contextual anchors** within the divergence pipeline: takes the most recent several sentences of context, performs association intersection and word-vector cosine scoring per sentence, sorts them, and takes the top-ranked as anchors, with high-frequency words receiving soft down-weighting.
  - Module `p1_node0_data_recall.mjs` provides data three-tier near-miss recall, disabled by default and in gray-out status.
  - **The actual memory recall is a separate line**: independently invoked by the memory recall module `memoryRecall.mjs` before the divergence pipeline; recalled fragments are incorporated into dialogue history as system messages, not injected as recalled-memory XML. The contextual anchors within the divergence pipeline and the actual memory recall do not reference each other (their isolation is a design constraint).
- **Key parameters**: The context sentence count is an initial default; anchor strength uses an increment formula related to hit count; data three-tier recall is disabled by default; the three-tier weights decrease from hot to warm to cold; data recall strength has an upper limit to ensure recall does not dominate.
- **Known issues**: The actual memory recall currently does not yet read the hot/cold compressed layers (instead traversing the entire memory directory tree); the "read compressed layers" item was judged by the designer as deferred. Data three-tier recall is disabled by default, pending verification before promotion. The designer annotated this stage as "requiring further discussion and positioning" -- it is an undecided item.

### 2.3.3 Node 1: Contraction-1 (Tokenization + Exclude Non-Information Words)

- **Design principle**: After contraction, the tokenizer tokenizes and excludes non-information content; first contract, then diverge, providing anchors for divergence.
- **Processing mechanism**: After tokenization, non-information words (function words, ultra-high-frequency words) are excluded, yielding meaningful words as anchors. **Exception**: degree adverbs and polarity intensifiers (e.g., "so," "too," "very") are not removed as noise but retained as intensity and polarity weighting signals for adjacent content words.
- **Current implementation**: Module `p1_node1_tokenize.mjs` handles tokenization and non-information-word exclusion, using a tokenizer combined with high-frequency word lists to exclude non-information words, with degree adverbs and polarity words retained separately. This node is called serially within the main divergence flow.
- **Key parameters**: The high-frequency word frequency threshold is an experimentally calibrated fixed value; resources used include a tokenization component, part-of-speech dictionary (for POS cross-validation), a word-frequency table of approximately 100,000+ entries, multiple stopword lists, and a degree-adverb list.
- **Known issues**: None. In usable status within the component library.

### 2.3.4 Node 2: Divergence-1 (Associative Divergence, P1 Function 2, Divergence Engine Core)

- **Design principle**: Perform associative divergence using original content plus context; associative divergence is the core divergence mechanism, with the adapter as its companion conversion mechanism.
- **Processing mechanism**: Meaningful words plus context undergo associative divergence to produce a scatter-word pool. **Divergence distance must stay in the mid-to-long range**; synonymous close-range expansion is prohibited (this is a red line).
- **Current implementation**: Module `p1_node2_swow.mjs` handles associative divergence. The main path uses a "query--key--value" style pool-convergence divergence: the centroid of input-word vectors serves as the query; the cosine similarity of association cue words to the centroid serves as the key; chain re-divergence from convergent cue words yields the value. A dual gate is applied: cue words must have a direct associative relationship with the input, and cosine similarity must reach a threshold; this path is only activated when the input word count reaches a minimum (to prevent single-word explosion). Returns the scatter-word pool and input centroid. The design records also preserve a comment noting that an earlier "per-word independent associative divergence fallback" branch was purely deleted for violating the "per-word divergence prohibited" red line.
- **Key parameters**: Associative divergence distance stays in the mid-to-long range (red line); pool convergence size is an experimentally calibrated fixed value (larger sizes, while causing only moderate degradation, are prone to word drift and significantly increased computational cost); cue cosine threshold and association candidate count limit are companion parameters.
- **Known issues**: None. Historically, synonymous close-range expansion once caused recall quality to drop drastically (approximately 70%) -- a lesson paid for in blood, now locked as a red line.

### 2.3.5 Node 3: Six-Axis Independent Parallel Divergence (Multi-Dimensional per Axis, 6+n)

- **Design principle**: Each of the six axes is multi-dimensional (six disciplines, each containing multiple sub-direction positions), with each axis equipped with corresponding resources; the six axes form a "plane" and should not be reduced to a "line"; the six run in parallel and merge at the end for relevance observation. The designer once hand-wrote an example illustrating the "plane" form: for the sentence "Why are you so stupid," information words "stupid" and "fool" can be extracted; each axis produces output independently -- informatics yields negation, opposition, error, disappointment; logic yields error, long-term issue, loss; psychology yields negative, disappointment, unmet expectations, optimization desire, sympathy; sociology yields complaining, dissatisfaction, bewildered puzzlement; cognitive science yields expectation deviation; linguistics yields negative -- with "so" serving to intensify the information of "stupid."
- **Processing mechanism**: The scatter-word pool undergoes independent parallel divergence across six disciplinary axes (each with multi-dimensional judgment and dedicated resources); each outputs a "plane" (a rich set of information, not a single score); these merge into a single pool for relevance observation, carrying the main-direction axis and decay.
- **Current implementation**: Module `p1_node3_axis6.mjs` handles six-axis divergence. The scatter-word pool undergoes each of the six axes outputting planes, with axis decay included. Returns each axis's plane, axis decay, main axis, and word-attribute profile. The **axis decay mechanism** works as follows: the relevance of each axis is calculated (the sum of candidate values on that axis), ranked in descending order of relevance, with decay decreasing exponentially by rank -- the main axis (top-ranked) has the highest value, while distant axes decay exponentially but are always greater than zero, never reaching zero (soft isolation). A separate soft-stop threshold is set: axes with relevance below this threshold no longer diverge (no new anchors are injected), but their existing "planes" are not deleted.
- **Key parameters**: The axis decay coefficient is an experimentally calibrated fixed value (a larger coefficient produces more aggressive decay for distant axes); the soft-stop threshold is a fixed ratio. Axis-specific resources include emotion and affect lexicons for psychology, domain lexicons for informatics, etc.
- **Known issues**: Two sub-mechanisms were once flagged as framework deviations; their wiring is currently normal.

### 2.3.6 Node 4: Sub-Direction Space Refinement + 300-Dimensional Word Vectors

- **Design principle**: The sub-direction space is used for refined positioning; the six axes determine the divergence point, while the sub-direction space performs approximate positioning followed by expansion and output. The six axes and the sub-direction space are not the same thing; the sub-directions are "originally activated, not all." The system has adjudicated: scoring is the responsibility of the scoring framework and word vectors, not the sub-direction space (sub-directions only position, not score).
- **Processing mechanism**: The six-axis divergence results are subjected to detailed **positioning** in the fine sub-direction space (the sub-direction space is a positioning coordinate, not a property scorer), assisted by word-vector dimensions, to determine which sub-directions to activate (not all). The sub-direction space is the spatial positioning at the output end, not a subordinate sub-classification of the six disciplinary axes.
- **Current implementation**: Module `p1_node4_axis47.mjs` handles sub-direction positioning. Scatter words that hit terms are recorded in the hit set; after rewriting, the module **only positions, does not score**, and returns the activated set and hit evidence set.
- **Key parameters**: Resources used include the sub-direction coordinate term table, low-dimension fallback summaries, and word-vector tables.
- **Known issues**: A historical audit recorded a suspected defect where sub-direction key naming divergence caused silent score loss; verification against the current code is needed to determine whether it has been fixed (this chapter only records, does not adjudicate). The designer also acknowledged that the sub-direction space design is not yet mature, while the six-axis division is sound.

### 2.3.7 Node 5: Resource-Library Multi-Resource Positioning Refinement (Operator, Reusable at Multiple Points)

- **Design principle**: Use the resource library's multiple resources for positioning and refinement; the system's resource library is rich and should be fully utilized; positioning is refinement, and the resource library's positioning refinement can be reused at multiple points, not just one -- the system is "building process," not "patching." This stage should be placed **before** spatial voting.
- **Processing mechanism**: Uses multiple resources from the P1 resource library for candidate positioning and refinement. This is **not a one-time single-point step but an operator reusable at multiple points in the flow (e.g., Nodes 4, 6, 7)**, producing only "confirmation signals" (how many resources confirmed this position and semantic relationship) without modifying coordinates, voting, or sorting.
- **Current implementation**: Module `p1_node5_resource.mjs` handles resource cross-confirmation, using ConceptNet, CiLin, synonym dictionaries, antonym dictionaries, commonsense knowledge bases, and other resources for cross-confirmation, producing only confirmation counts and semantic relationships without modifying coordinates or voting. This function is connected to the information-word cleaning stage.
- **Key parameters**: Resources used include a large-scale concept network, commonsense knowledge base, CiLin, synonym dictionary, frame-semantic database, etc. (plus several expandable but not yet connected resources).
- **Known issues**: A historical audit once concluded "this node runs empty," which has been refuted upon verification (the node does have downstream consumers, and its confirmation signals are consumed).

### 2.3.8 Node 6: Aggregate into a Single Pool -> Space -> Content-Distribution Voting (Main Ranking)

- **Design principle**: Aggregate into a single pool -- not multiplication, but space, performing content-distribution voting; the system uses spatial addition, not linear multiplication, not hard matching; draw a circle with temperature -- too close won't do, too far won't do either, filtering is needed; spatial matching is superior -- match within space, exclude those outside space, find those within space.
- **Processing mechanism**: Candidates after positioning refinement are aggregated into a single space (**addition, not multiplication, not hard matching**), subjected to content-distribution voting, with multiple anchors determined via multi-dimensional coordinates, then a circle drawn with temperature as the boundary. Too-close candidates are excluded (dead words, redundancy); too-far candidates naturally decay (not hard-deleted); the middle sweet spot is retained.
- **Current implementation**: Module `p1_node6_spaceVote.mjs` handles spatial voting and serves as the main ranking stage for information-word scoring. It employs **many-to-one cumulative voting**: each candidate independently votes for each target; total votes are the per-item cumulative sum (no chained multiplication, no division by path count). Core logic: based on word-vector distance, candidates below the voting floor (too far) do not vote; those outside the circle are not hard-deleted (used only for sorting and anchor filtering); a single vote equals inverse-distance weight times candidate weight, cumulated into total votes. The circle-drawing logic with temperature: temperature is determined by input word count in tiers (short sentences get high temperature / large circle, long sentences get low temperature / small circle); circle radius equals base radius times temperature.
- **Key parameters** (all current measured values): inverse-distance steepness, base radius, temperature tier values (short sentences high temperature, long sentences low temperature), inner-boundary ratio (disabled by default), domain bonus factor -- among these, the steepness value adjudicated through three-tier experiments is an experimentally calibrated fixed value; the base radius is a blunt-tuning parameter; the inner-boundary ratio is disabled by default.
- **Known issues**: **The "too close" inner boundary stage was removed because its threshold lacked justification**; the current inner-boundary ratio is disabled by default (to ensure zero regression), with its experimental tier pending large-scale A/B testing. Part of the "too close" function is now handled by Node 10's sweet-spot decay. An important engineering constraint applies here: **never patch voting by "multiplying by a quality coefficient"** -- chained multiplication is equivalent to hard matching, violating the "spatial additive, not multiplicative" design principle (this approach was once introduced and then deleted; code comments explicitly record this red line). The historical audit conclusion that "this node is dead code" has been refuted.

### 2.3.9 Node 7: Diverge Information Words (Second Divergence)

- **Design principle**: Diverge information words after spatial voting; the system was designed with two rounds of divergence -- the first is context plus association, the second further diverges into information words; divergence words include cross-domain associations, upstream/downstream flow associations, and attribution associations; six degrees of separation can be simplified to two to three hops, with automatic stopping when the connection becomes too weak.
- **Processing mechanism**: Spatial voting results undergo a second divergence to produce information words, providing more useful possibilities for direction words. The products of all paths are merged into the information-word list, participating additively in Node 9's voting as additional information words, rather than replacing Node 9's voting mechanism.
- **Current implementation**: This stage is inlined within the adapter module and contains **multiple divergence paths**, each gated by an independent switch (all enabled by default). All paths share a deduplication graph, normalization scale, and push helper (raw scores are normalized before merging, maintaining a form consistent with "planes"). The paths and their data sources are as follows:

  | Path | Data Source | Trigger Method | Decay Mechanism |
  |---|---|---|---|
  | Personalized random walk | Knowledge graph (word/concept/term nodes) | Input words as seeds | Power iteration with damping coefficient and natural decay |
  | Two-hop association | Anchor concepts via commonsense KB to terms | Top-ranked first-hop association results | Two hops with decay coefficient; cross-axis and same-axis weighted separately; per-word cap |
  | Causal association | Anchors via commonsense KB causal edges to terms | Anchor association results as seeds | By commonsense KB causal type; relay down-weighting along path |
  | Analogical association | Main-axis anchors to other axes via word-vector cosine matching | Forward: main axis to other axes; reverse: secondary axis to main axis | Cross-domain structural isomorphism; inverted-U sweet-spot gating; anchor count and per-anchor cap |
  | Six-degree association | Anchors via commonsense KB all-relation one-to-two hops to terms | Top-ranked anchors as seeds | Independent walk with deduplication and decay coefficient; escalating rewards for cross-domain hops |

  Taking six-degree cross-domain divergence as an example, the core logic is: for each term reached by walking, different discriminant weights are applied depending on whether the walk crosses axes, multiplied by path decay (decreasing by hop count, seed score excluded); when path decay falls below the stop threshold, the walk terminates. The more domains involved in cross-domain hopping, the higher the cross-domain reward (encouraging cross-disciplinary association); already-collected terms are not pushed again. This design corresponds to the idea that "cross-framework analogy is essentially six-degree distribution."
- **Key parameters**: Damping coefficients, iteration limits, decay coefficients, reward caps, cross-domain reward coefficients, and node-level overall scaling for each path are a mixture of experimentally calibrated fixed values and initial defaults.
- **Known issues**: This stage is wrapped in exception handling; thrown errors do not affect the main chain (a reasonable design). A scoring-framework call mentioned in the header comment does not exist in the current code (see Node 8 known issues for details).

### 2.3.10 Node 8: Scoring Framework + Filtering-1 (Filter Information Words)

- **Design principle**: The scoring framework is used for scoring and filtering (usable at multiple points); the scoring framework is an algorithm framework, the adapter is the aggregate of all conversion mechanisms and includes the scoring framework; associative divergence is the core divergence, the scoring framework is the adapter; the product should be replaced with the mean; multi-dimensional annotation rather than single-content annotation is needed (i.e., space). The scoring framework is the "scoring apparatus" inside the adapter, **neither a divergence engine nor a selector** -- direction is "selected" by the voting stage; the scoring framework, after selection, only performs down-weighting, dead-word filtering, and red-line processing.
- **Processing mechanism**: Information words are scored by the scoring framework and then filtered (retaining high quality, down-weighting catch-all terms, noise, polarity mismatches, and redundancy). The contraction stage includes lateral inhibition (near-synonym deduplication), diversity re-ranking, and quotas (ensuring each axis has representation).
- **Current implementation** (the scoring framework resides in `p1_node8_10_blq.mjs`): The core is **a weighted linear sum of six additive dimensions, minus additive penalties from several suppression dimensions** (using linear combination rather than chained multiplication). The six additive dimensions are: spatial distance term, word-frequency saturation term, cross-disciplinary path harmony term (counted here only, never redundantly multiplied in the outer layer), word-vector relevance term, specificity term, and resource confirmation term. The four suppression dimensions are additive penalties: catch-all term, polarity mismatch, irrelevance, and isolated noise. The final score takes the greater of "additive sum" and "additive sum minus total penalties" (with a soft floor to prevent multiple gates from cumulatively hard-zeroing the score). The lateral inhibition stage executes full scoring plus lateral inhibition (near-synonym suppression), diversity re-ranking, and quota limits.
- **Key parameters**: All additive-dimension weights and penalty coefficients are experimentally calibrated fixed values; the lateral-inhibition near-synonym threshold, diversity coefficient, per-axis and per-dimension quotas, and output count are fixed values.
- **Known issues (important)**:
  1. **The scoring framework is currently a "dead reference" (orphan)**: Although the adapter module contains a reference declaration for the scoring framework, there is no actual invocation anywhere in the file, nor any corresponding gate switch. The header comment's claim of "called by the adapter, gate enabled" does not match what is on disk. **In the current active pipeline, the scoring framework does not participate in scoring** -- information-word scoring is actually handled by Node 6's spatial voting and Node 3's axis decay. The scoring framework's six-dimensional framework is a fully implemented design (code is readable line by line) but has not yet been connected to the main loop.
  2. The complete fine-ranking shell of this node is also an orphan (no production call).
  3. Algorithm history: an older version used a four-suppression-dimension chained-multiplication formula (exponential suppression when all triggered), which ran counter to the design direction. Experiments showed the product formula caused recall to drop drastically (approximately 60%); the geometric-mean scheme also significantly worsened performance; additive superiority over multiplicative is a conclusion paid for in blood and fixed.

### 2.3.11 Node 9: Information Words as Pool -> Space -> Select Direction Words (Sole Word-Output Path)

- **Design principle**: Information words then serve as a pool and space from which direction words are selected; multiple information words correspond to one direction (many-to-one), not one information word to multiple direction words; not one word diverging a pile, but information-pool divergence; direction words are suggestions to the main model, not judgments about the user.
- **Processing mechanism**: Information words as a whole serve as a pool; in space, observe what direction the pool points to, perform **many-to-one voting**, and select direction words.
- **Current implementation**: Module `p1_node9_dirword.mjs` handles direction-word selection and is the **sole word-output path**. It employs Hough-style many-to-one voting: each information word votes for each eligible target (additively); votes are cumulated into total votes (spatial additive, not multiplicative). At the closing stage, total votes are multiplied by axis decay to obtain the final score.
- **Key parameters**: Default decay value, multi-voter enabled (each information word votes independently to achieve many-to-one), Hough voting top-N count, direction-word output count (approximately twenty).
- **Known issues**: The output of a certain word class exhibits structural skew (near-synonym merging cannot resolve it); this is classified as a pending issue in the word-production line.

### 2.3.12 Node 10: Scoring + Filtering-2 -> Output (Live Production Stage)

- **Design principle**: Scoring plus filtering; outputting dead words is acceptable -- high-volume near-miss recall is fine, but the direction must align with the conversation; provide direction, do not provide routes, induce, or substitute for user expression; words the main model could derive by reading the raw text are dead words; remove words that would cause the main model to mistakenly believe they are the user's subjective experience.
- **Processing mechanism**: Direction words undergo a second filtering before final output, excluding dead words, route words, diagnostic words, subjective-experience words, and polarity-mismatched words.
- **Current implementation** (Node 10 is a live production stage):
  - The direction-word fine-ranking stage is genuinely called by `p1_pipeline.mjs` (gate enabled by default). It **does not run the six-dimensional linear sum** but only applies "Node 9 score times Gaussian gradual decay" (this decay is for position calculation, not score suppression) plus cliff abandonment (breaking the ceiling of "fill a fixed count") plus red-line annotation. This stage does not reuse the scoring framework's six-dimensional scoring; it retains only "decay plus red lines."
  - The red-line judgment stage is called by `p1_pipeline.mjs` (gate enabled by default) and performs **hard removal** (hits are removed and do not enter direction-word output): Category 1 is route words (suggest, should, method, steps, etc.); Category 2 is induction words ("you need," "you must," etc.); Category 3 is subjective-experience words; Category 4 is diagnostic words (disorder, patient, and various disease names, with processing to exclude the character for "symptom" from "symptoms"). 
- **Key parameters**: Output count (contractually fixed length), cliff ratio and cliff floor, regex seeds for the four red-line categories (structural constants, not numerical magic numbers).
- **Known issues**: Node 10 internally only performs soft down-weighting and annotation for red lines; hard removal is executed at the pipeline layer's red-line judgment stage. Node 10 **does not usurp authority** -- the many-to-one voting order from Node 9 takes precedence; Node 10 only performs down-weighting, decay, and red-line processing. This node has removed the quality-gate chained multiplication from the old version (which was a dead operation that would distort white-box observation).

### 2.3.13 Pervasive Mechanism One: Hot-Swappable Self-Learning

- **Design principle**: In the hot-swapping mechanism, a large lexicon is equivalent to an additional divergence axis; iterative correction is hot-swapping, which is neither temperature nor decay; like typing, frequently occurring or similar content can be recorded; having the system build its own lexicons based on conversation is optimal.
- **Processing mechanism**: The system employs a three-tier lexicon -- a built-in fixed layer, a pluggable adaptation layer, and a user self-learning layer. A large lexicon equals an additional divergence axis for Node 3 (six axes extending to seven or more). The "typing mechanism" is self-learning: like an input-method lexicon, high-frequency or similar words are recorded and promoted. Offline batch processing produces new lexicons, which are hot-loaded (periodic polling monitors file modification times; upon change, the cache is cleared and takes effect without restart), rather than real-time parameter modification.
- **Current implementation**: The pipeline module includes a hot-reload check (periodic throttled checking of lexicon file modification times). Asynchronous writing to the self-learning disk: per-axis statistics and word-frequency statistics are accumulated into the user lexicon; the adapter side writes word-frequency statistics.
- **Key parameters**: The hot-reload polling interval is a fixed value.
- **Known issues**: The read/write sides are implemented (word-frequency statistics and promotion are operational); however, offline batch-processing triggers, automatic promotion of self-learned words to the library, and co-occurrence statistics are not yet implemented -- currently, hot-swapping can only be triggered by manually editing configuration files. Additionally, lexicon changes must be synchronized in both the activation term table and the adapter index; otherwise, new words cannot be hit (ironclad rule). Note a same-name confusion: the front end's "typewriter streaming rendering" and P1's "typing mechanism" (self-learning) share the same name but are unrelated.

### 2.3.14 Pervasive Mechanism Two: White-Box Observability

- **Design principle**: Viewing the actual route through single-point breakpoints without running the full volume is the supreme principle; the use of scoring tools is prohibited -- the system itself must examine actual output.
- **Processing mechanism**: After passing through each node, the following can be observed: what the input was, what was done, what the output was, and why this output rather than another. A breakpoint can be set at any node to view the complete intermediate state.
- **Current implementation**: Module `p1_whitebox.mjs` provides tracing functionality, embedding the above four questions at the entrance and exit of each node, permanently enabled by default. Taking Node 6 as an example, its tracing segment instruments the input, processing, and reasoning segments in full.
- **Key parameters**: The white-box switch is enabled by default.
- **Known issues**: None. This is the implementation of the designer's supreme principle and cannot be disabled.

## 2.4 Appendix: Historical Architectural Versions

> This section describes the system's **historical architectural versions**. Their structures, nodes, and data flows are valuable for understanding the origins of the current design, but **line-number anchors and files have become invalid following architectural migration** and do not represent the current implementation. Readers should focus on structures and design intent, not specific details.

### 2.4.1 Biomimetic Three-Layer Architecture (Early Version)

In the early period, the system used a biomimetic analogy to divide the overall structure into three layers: P1 as the "eyes" (scanning input contours, providing direction words), the main model as the "brain" (seeing directions, making decisions, writing replies), and collaborative agents as the "hands" (exploring, searching, verifying). The designer positioned P1 as a visual system: giving the main model a map with routes already marked, rather than letting it start from a blank sheet.

```
P1 = Eyes (scan contours, provide direction words)
  Input: user dialogue + dialogue history + memory
  Processing: three-stage flow (contraction -> divergence -> contraction)
  Output: direction-word XML (cognitive terms / direction words / recalled memories /
          discourse / emotion / scene / hints)
        | Direction-word injection (hand over a map with routes marked)
        v
Main model = Brain (see directions, make decisions, write replies)
  Receive direction words -> make decisions and organize replies based on direction
  -> cross-disciplinary analogical expansion
        | Dispatch tasks
        v
Agents = Hands (explore / search / verify)
  Code research - web and historical recall - experimental verification
```

### 2.4.2 Three-Stage Flow (Early Version)

The early architecture employed a three-stage flow: Contraction-1 (integration and coordinate accumulation), Divergence (association plus vector divergence, with multiple mechanisms in parallel: plot, embodied, metaphor, narrative, opposition, analogy), and Contraction-2 (adapter voting). This version's Contraction-2 used multi-factor voting (dominated by per-word lookup), which was the root cause of the subsequent catch-all term phenomenon. The current architecture has rewritten Contraction-2 as additive scoring, switching the paradigm from "per-word lookup dominated" to "spatial search dominated" (see 2.4.5). The three-stage structure itself remains valid; specific line numbers have become invalid.

### 2.4.3 Five Fixed Axes Plus Decay (Early Version)

The early version used five fixed axes (without cognitive science): psychology, informatics, sociology, logic, and linguistics. The current finalized six axes include cognitive science. In certain early modes, cognitive science was an "activated axis" rather than a "fixed axis," constituting a historical formulation tension -- the current finalized six axes include cognitive science, while the historical five-fixed-axes version does not. The decay formula used exponential decay by axis distance, with tiered coefficients, following the "no hard deletion, do not affect the main force" soft-isolation principle.

### 2.4.4 Point-Line-Plane-Volume Architecture (Early Version)

The early version used "point, line, plane, volume" to characterize spatial structure: point as a single activated term or atomic concept, line as axial connections and relationship chains, plane as multi-axis intersection planes, volume as the full architectural solid and cross-disciplinary isomorphic structures. Data connects from points into lines, lines weave into planes, and planes constitute volumes. The adapter index entry counts annotated in the diagram are early snapshot values; current measured values are counted separately.

### 2.4.5 Three-Epoch Evolution (Structure Valid, Details Invalidated)

The system's codebase underwent three epochs of evolution, forming the historical foundation for understanding "why the current architecture is a node pipeline":

| Epoch | Name | Status | Period |
|---|---|---|---|
| First Epoch | Monolithic architecture | Retired | Late April to late May 2026 |
| Second Epoch | Three-file architecture | Retired | Finalized late May 2026 |
| Third Epoch | Node pipeline (current) | Current production | From late May 2026 |

- **Why the First Epoch was abandoned**: First, size ran out of control (a single file once reached over 400,000 bytes, nearly 8,000 lines); second, maintenance was intractable (successive versions diagnosed the same batch of persistent defects but could not fix them -- monolithic coupling meant modifying one place could crash the whole system); third, **the paradigm was overturned** -- switching from per-word lookup dominated (catch-all term rate approximately 70%) to spatial search dominated (catch-all term rate approximately 4%).
- **Why the Second Epoch was abandoned**: It was still file-level linear invocation, unable to support node-level hot-swapping, white-box instrumentation, and route switching. The Third Epoch replaced linear invocation with pipeline orchestration, thereby supporting switchable three-route schemes. The transition from Second to Third Epoch was not an overhaul but a reorganization plus renaming (the adapter module was directly renamed from the old divergence module).
- **The Third Epoch continues to evolve**: One representative evolution is the "de-collapse" transformation of the sub-direction space -- the sub-direction space was reverted to a range gate, with scoring delegated to the scoring framework and word vectors. The designer's adjudication was: "Scoring is the responsibility of the scoring framework and word vectors, not the sub-direction space."

**Quantitative evidence of the paradigm shift**:

| Paradigm | Dominant Mechanism | Catch-All Term Rate |
|---|---|---|
| Old paradigm | Per-word lookup inverted index | ~74% |
| New paradigm | Spatial search (word-vector centroid/range) dominated | ~4% |

The number of factors in the scoring framework was repeatedly added and removed during evolution (initially expanding from six factors to over ten, at one point reaching seventeen; then rewritten in one pass, with an approximately 290-line additive framework replacing the old approximately 3,000-line chained-multiplication framework; subsequently, several factors were further merged with reranking fusion schemes). The factor count is highly inconsistent across different historical snapshots; no locking is attempted here -- only the evolutionary trend is recorded.

### 2.4.6 Scoring Trajectory (Historical Milestones)

During development, the system used composite scores as its iterative target. The milestones are as follows (for understanding algorithm evolution):

| Version Stage | Composite Score | Core Change |
|---|---|---|
| Early | ~2.01 | Dual-channel fusion |
| Post-lexicon | ~2.96 | Five lexicons, ~6,700 words |
| Post-dual-round expansion | ~3.69 | Vocabulary expansion |
| Post-fusion | ~3.62 | Mode fusion |
| Axis-mean algorithm | ~4.05 | Axis-mean algorithm (first breach of 4.0) |
| Routing + catch-all governance | ~4.04 | Large/medium/small routing + Contraction-2 catch-all governance |

The composite score approximately doubled from early to late versions. Catch-all term occurrences dropped drastically during this process (approximately 80% reduction). A critical lesson: the designer noted that "modifying formulas is all treating symptoms" -- multiple rounds of formula-modification experiments demonstrated that merely adjusting the scoring formula can only transform one type of catch-all term into another; the fundamental solution is **three-tier routing by input scale** (locally triggering fine ranking based on input, rather than global scoring).

## 2.5 Summary

This chapter has presented the complete architecture and processing flow of the P1 system. The system's processing skeleton is a five-step standard chain: six axes and mechanisms run in parallel and independently; merge into a single pool; perform content-distribution voting and scoring within the pool; find proximate axes and positions; diffuse along temperature to define the boundary; and finally, information words serve as a pool from which direction words are selected. Several design judgments in this chain serve as the system's cornerstones: mechanism parallelism rather than axis parallelism; the pool is spatial additive rather than linear multiplicative; scoring is additive voting rather than multi-factor chained multiplication; the temperature circle establishes the divergence boundary by "filtering out both too-close and too-far"; axis decay only down-weights and never deletes, achieving soft isolation.

At the implementation level, the system orchestrates over ten processing nodes through a node pipeline, accompanied by two mechanisms that cut across the entire flow -- hot-swappable self-learning and white-box observability -- and reserves three route schemes in which the LLM optimizer can be inserted at different positions. This chapter has provided a per-node specification-level description and truthfully annotated the gaps between current implementation and design intent -- most notably, the scoring framework is currently an orphan implementation not connected to the main chain, with information-word scoring actually handled by spatial voting and axis decay; the "too close" inner boundary was removed due to lack of threshold justification, with its function partially assumed by the sweet-spot decay in later-stage nodes; the LLM stages of the three routes have not yet been merged into the main chain.

The system status declared at the beginning of this chapter must be reiterated: the complete self-driven divergence chain described in this chapter is an algorithm implemented within the component library and awaiting reconnection; live word production is currently handled by AI preset retrieval. The system's historical evolution (Appendix 2.4) shows that the current node-pipeline architecture was formed after the monolithic architecture's size ran out of control and the paradigm shifted from per-word lookup to spatial search -- this paradigm shift reduced the catch-all term rate from approximately 70% to approximately 4%, which is the key historical thread for understanding the current architecture.
