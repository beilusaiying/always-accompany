# Chapter 4 Memory System

## 4. Introduction

This chapter describes the memory subsystem of the external Divergence & Recall thought-chain system. The subsystem serves two functions: first, it provides the primary conversational model with filtered, trustworthy historical fact fragments (termed "precise injection"); second, it supplies starting points for divergent reasoning (termed "divergence anchors"). Together, these form the memory foundation of the system's cognitive rhythm of "contract first, diverge, then contract again."

Before expanding on technical details, a distinction regarding implementation status that runs throughout this chapter must be clarified. The self-driven recall pipeline and the native recall module of this memory system are both currently in **component state**: algorithms are implemented and tested in isolation, but have not yet been reconnected to the production main pipeline. In the current production environment (hereafter referred to as live state), memory recall is handled by an LLM-based retrieval preset. Accordingly, the majority of recall and divergence algorithms described in this chapter are "implemented component-library algorithms awaiting reconnection," rather than actual live-state behavior. Wherever "what is currently running" is concerned, this chapter will explicitly state so, and will not misrepresent component-state designs as live behavior.

The chapter is organized as follows: Section 4.1 establishes the design foundations of the memory system, namely the designer's independent observations on human memory and their post-hoc correspondence with academic memory models; Section 4.2 describes the physical organization of the data layer; Section 4.3 describes the memory archival processing pipeline; Section 4.4 describes the dual-line recall mechanism; Section 4.5 provides an overview of the injection mechanism; Section 4.6 reports empirical results and the current live-state declaration; Section 4.7 is the summary.

---

## 4.1 Design Foundations: Human Memory Model

### 4.1.1 Design-First Bionic Positioning

The entire memory system — including the data layer, the hot/warm/cold three-layer hierarchy, and keyword recall — is designed on the basis of the designer's understanding of human transient memory and conscious memory mechanisms, together with a set of formulas simulating memory decay and reinforcement. This is a design-first architectural decision, not a reimplementation of any single academic publication.

Understanding this "bionic" nature requires distinguishing three layers of evidence, all indispensable:

- **First layer: the designer's positioning.** The designer explicitly characterized: the entire memory system is designed based on an understanding of human transient memory, conscious memory, and memory formulas. This is the designer's own characterization of their design intent, and constitutes the highest authority.
- **Second layer: post-hoc academic correspondence.** After the system was implemented, academic labels were applied to its decay, layering, and recall mechanisms, including the multi-store memory model (Atkinson-Shiffrin), the forgetting curve (Ebbinghaus), and the scoring paradigm of Generative Agents. These labels are post-hoc academic indices for external communication and literature retrieval, not design bases.
- **Third layer: code evidence.** The three-layer directory structure, multi-dimensional scoring, exponential decay, hierarchical voting, and other real, reproducible code. This is the system's actual behavior.

The key clarification concerns the direction of the evidential chain: the designer made design decisions based on their own understanding of human memory (transient memory, conscious memory, and memory formulas), and only afterward discovered that these designs closely corresponded to the academic Atkinson-Shiffrin multi-store model, the Ebbinghaus forgetting curve, and so on, whereupon they applied labels for academic archival. The academic theory names are "post-hoc indices," not "prior blueprints."

It should be noted that terms such as "Atkinson-Shiffrin" or "Ebbinghaus" do not appear in the design records; correspondences such as "the hot/warm/cold layers correspond to the multi-store model" and "the decay formula corresponds to the forgetting curve" were all identified during post-hoc consolidation. This corroborates the positioning of this section: design first, academic labels as post-hoc correspondence.

### 4.1.2 The Designer's Direct Description of Memory Mechanisms

Although the designer did not use academic terminology, their description of how the system works was itself given in terms of human memory and human cognition, constituting the direct substance of the "bionic" design. The memory retrieval mechanism was designed as: using the current context and attention focus as the query, combining multi-axis look-back over existing content (data layer, hot layer, cold layer), matching by lexical keywords and then extracting results to inform the primary model — the entire process does not rely on complex intelligent judgment. The overall cognitive rhythm of the design originates from the designer's direct observation of human cognitive processes, whose original formulation is as follows:

> "Humans contract, diverge, and then contract again. For example, when I see water, the first thing I think of is drowning — that's a past memory — then I diverge, like falling down, which is safety first, then recreation, like boating, and then I contract again." (designer's original words)

The above observation translates into a design principle: the overall cognitive rhythm imitates the human process of "contracting from a single memory point, diverging toward multiple related directions, and then contracting again to a safe landing point" — a composite framework-based mode of thinking. The system is designed to imitate how humans invoke an entire composite framework and think within framework and divergence, rather than thinking at a single point. The designer also explicitly advocated drawing from large language models, graphical models, bionics, and other fields.

### 4.1.3 Memory Formula Family and Their Implementation Points

The memory formula family is the code implementation of the "memory formula design." The table below maps each formula to a specific point in the system, its corresponding human memory mechanism, and the post-hoc academic label. Unless explicitly marked as initial default values, the coefficients in the table are experimentally calibrated fixed values.

| Formula family | Expression | System location | Corresponding human memory mechanism | Post-hoc academic label |
|--------|--------|----------|--------------------|--------------|
| Decay: hot-layer injection ranking | `score = weight × 1/(1 + days_since × 0.1)` | Hot-layer permanent memory Top-K sorting | The older, the fainter; important and recently triggered items are recalled first | Forgetting curve |
| Decay: recency dimension at recall time | `dRec = 0.995^(hours_since_now)`, approximately 0.5% decay per hour | Native recall scoring | Temporally recent memories are more easily recalled | Recency in Generative Agents |
| Capacity: hot-layer Top-K | Permanent memory injection limit of approximately 100 entries (initial default) | Hot-layer injection | Working memory capacity is limited | — |
| Capacity: recall injection budget | Maximum 5 entries per recall (initial default) | Native recall injection | Attention focus capacity is limited | — |
| Capacity: divergence direction word limit | Each node has a direction word upper bound | Divergence nodes | Short-term memory capacity is approximately seven items | Miller's Law (7±2) |
| Rehearsal reinforcement: hit refresh | Permanent entries hit by actual injection refresh their last-triggered timestamp (throttled: only refreshes if more than one day since last refresh) | Hot-layer ranking | Rehearsal consolidates memory; spaced repetition | Spaced repetition |
| Literal dimension: rarity weighting | `idf = log((N+1)/(freq+1))`, where N is the total word frequency of the reference corpus | Native recall literal dimension | Rare proper nouns carry higher information — more "eye-catching" and easier to remember | TF-IDF smoothed variant |

Several key formulas are elaborated below.

**Hot-layer injection ranking (decay, capacity, and rehearsal reinforcement combined).** The injection ranking of hot-layer permanent memory is determined by the product of importance and recency decay. Importance is a weight assigned at write time (initial default value of 1); the higher the weight, the higher the priority, corresponding to "important things are remembered firmly." The recency decay term `1/(1 + d × 0.1)` decays as the number of days d since the last trigger increases: 1.0 on the day of trigger, 0.5 after ten days, approximately 0.09 after one hundred days. Rehearsal reinforcement is embodied as: entries hit by actual injection in the primary conversation have their last-triggered timestamp refreshed, with a throttle mechanism requiring more than one day before writing to disk; preview-type calls do not record hits to avoid contamination. This mechanism is the codification of "spaced repetition" — each time a memory is recalled, its decay clock is reset.

**Capacity constraints and Miller's Law.** Human short-term memory capacity is approximately seven items (Miller's Law, 7±2). The system maps this constraint to "divergence cannot expand indefinitely": the direction word upper limits at each divergence node and the entry budget for recall injection are all manifestations of capacity constraints. The design essence is the designer's intent of "high-volume near-miss recall, but injection must converge."

**Literal rarity weighting.** Inverse document frequency is used to weight matched words, with rare proper nouns receiving higher weights due to their low frequency. The inverse document frequency here uses a smoothed variant: `idf = log((N+1)/(freq+1))`, where N is the total word frequency scale of the reference corpus.

---

## 4.2 Data Layer Design

### 4.2.1 Layered Structure and Disk Organization

The data layer adopts a four-layer structure: one table layer (denoted L0) plus three memory layers — hot, warm, and cold (denoted L1, L2, L3) — the latter three being the "three-layer memory." Memory is stored in isolation per character. Each character's memory directory contains a configuration file, a memory preset file, a daily greeting status file, and table files for each of the three modes along with their automatic backups. Additionally, it includes hot-layer, warm-layer, and cold-layer subdirectories organized by function, as well as private spaces for each operating mode, session-isolated window directories, and self-learning word frequency directories. The system also maintains a global layer shared across characters.

The functional positioning of the three memory layers is as follows:

- **Hot layer.** Stores active memories — permanently remembered facts, user profile, agreements, and recent memories. **Fully injected every turn** into the primary conversational model. This layer is "always read." Within it, permanent memories are sorted by the aforementioned "importance times recency decay" formula, with the Top-K injected.
- **Warm layer.** Date-archived summaries of historical conversations, covering approximately the most recent month. Not injected by default; **retrieved by recall on demand only when hit**.
- **Cold layer.** Old memories beyond approximately one month; entire monthly directories are moved in from the warm layer. Not proactively injected by default; **only escalated for retrieval when triggered by keyword search**.

The table layer (L0) carries structured facts of the current context in comma-separated table form. It is injected every turn alongside the hot layer and belongs to the "must-read layer."

### 4.2.2 Correspondence Between the Three Layers and Human Memory

The correspondence between the three memory layers and human memory concepts is shown in the table below. It must be emphasized that the "corresponding human memory concept" column is a post-hoc academic correspondence, not the designer's verbatim definition; however, the designer's characterization of "hot layer always read, warm layer only viewed upon search, cold layer only triggered by keywords" itself constitutes the direct substance of the human memory layering mechanism (see Section 4.1).

| System layer | Per-turn behavior | Token budget | Corresponding human memory concept (post-hoc) |
|--------|----------|----------|------------------------------|
| L0 tables | Injected every turn (must-read layer, counted in hot-layer budget) | Counted in hot layer | Transient/sensory memory (current attention content) |
| Hot layer | Fully injected every turn | Approximately 7,000–11,000 (initial default range) | Working memory/consciousness (visible every turn, scale controlled) |
| Warm layer | Recalled on demand (hit by diffusion) | Approximately 2,000 (initial default) | Recent episodic memory (can be activated by retrieval) |
| Cold layer | Only escalated for deep retrieval by trigger words | On demand | Long-term semantic memory |

Layer determination in implementation is based on the leading segment of each memory entry's relative path: the hot-layer subdirectory is classified as hot layer, the cold-layer subdirectory as cold layer, and the rest as warm layer (neutral). Both the native recall side and the self-driven recall side each have an equivalent layer determination implementation, assigning decreasing ordinals to hot, warm, and cold layers respectively.

### 4.2.3 Entry Granularity and Heterogeneous Parsing

Recall does not operate on entire files but rather splits each storage file into "entries" according to its structure. The system supports parsing of multiple storage formats: entry arrays, table structures with rows, top-level arrays, objects with summaries and dates, generic objects, and line-by-line splitting as a fallback when parsing fails. Each extracted entry produces four fields: full-field text for matching, main content for injection display, raw data, and date hint. The display main content is selected by priority order of "event, item, body, summary, task"; if none are available, non-date fields are concatenated as a fallback. This entry-granularity design enables recall to be precise down to individual memory entries, rather than coarsely targeting entire files.

### 4.2.4 Default Table Structure and Archival Rules

The default tables in chat mode and their archival rules are as follows: the spacetime table is cleared at end-of-day; the character trait table, social table, and user profile table are permanent; the task/agreement table is archived into the hot-layer agreement file upon completion; the daily temporary memory table is archived into the warm layer in batches once it exceeds a threshold; the item inventory, facts about the user, and permanent memory tables are each archived into the corresponding hot-layer file when their respective conditions are met; the event summary table is cleared at end-of-day (content is first written to the daily summary); the historical spacetime memory table removes rows that exceed the age limit. The system also has private table structures for code mode and work mode.

### 4.2.5 Three-Mode Isolation and Concurrency Control

The system supports three operating modes — chat, code, and work — with memory spaces isolated along multiple dimensions: three sets of table files are fully independent, table caches are keyed by mode, and code and work modes each have dedicated private subdirectories. Session-based task state is isolated per session. The three modes **share** the hot/warm/cold three layers (written by chat mode archival; all three modes can read and search). Mode switching is recorded per session without mutual interference. The designer noted that storage-layer isolation is natural — character cards and conversation files inherently carry isolation information, so storage can be organized directly according to this information.

Concurrency correctness is ensured by three types of in-process locks: table save locks serialize write queues by file path to prevent concurrent overwrites; read-modify-write locks serialize read-modify-write sequences by file path to prevent lost updates. Additionally, configuration is refreshed from disk on each load to prevent cache staleness after panel modifications.

---

## 4.3 Memory Processing Pipeline

The memory processing pipeline consists of a set of archival/maintenance presets numbered P2 through P6, corresponding to the human memory encoding-consolidation process from short-term to long-term. A core fact must be stated upfront: among these presets, P3 through P6 are disabled by default, and actual production archival is handled by mechanical archival logic (automatic archival trigger checks and end-of-day archival flow); P2 is the only preset that automatically participates in the archival flow.

### 4.3.1 Preset Responsibilities and Default States

| Preset | Name | Default state | Trigger timing | Responsibility | Corresponding human memory stage (post-hoc) |
|------|------|--------|----------|------|------------------------------|
| P2 | Table summary/archival | Enabled | Temporary memory table exceeds threshold | Reads archived temporary memory data; adds a refined summary to the event summary table | Short-term to long-term encoding consolidation |
| P3 | Daily summary | Disabled | Manual | Consolidates the day's summaries; generates a daily summary and executes end-of-day archival | Sleep-phase memory consolidation |
| P4 | Hot-to-warm transfer | Disabled | Manual | Reviews the hot layer; calculates transfer scope by rules and archives (user profile is never moved) | Working memory to episodic memory migration |
| P5 | Monthly summary/archival | Disabled | Manual/automatic | Consolidates over-age daily summaries from the warm layer into monthly summaries and moves them to the cold layer | Episodic to semantic memory monthly consolidation |
| P6 | Format check/repair | Disabled | Manual | Checks and repairs format, indices, and fields (uniquely granted file deletion permission) | Introspective calibration of memory consolidation |

P5's monthly summary prompt currently has only a placeholder stub with no actual instructions; its mechanical version only performs directory migration from warm to cold layer without generating monthly summaries. P6 is the only preset in the entire system granted file deletion permission. Before deletion, three confirmations must pass: confirmation of corruption, confirmation that repair was attempted and recovery is impossible, and confirmation that deletion causes no cascading issues. All three must be satisfied for deletion to proceed; if any one fails, the action degrades to marking. User profile files may never be deleted.

### 4.3.2 Migration Conditions

The archival trigger conditions for each table and layer are shown in the table below. All thresholds are initial default values.

| Table/Layer | Trigger condition | Threshold (default) | Applicable mode |
|---------|----------|--------------|----------|
| Temporary memory table | Row count exceeds threshold | 50 | Chat only |
| Facts about user table | Date older than N days | 3 days | Chat only |
| Permanent memory table | Row count exceeds limit | 200 | Chat only |
| Spacetime memory table | Date older than N days | 2 days | Chat only |
| Warm to cold | At most once per day (date-stamp gate) | 30 days | All modes (per character) |
| Code/work experience table | Row count exceeds threshold | 80 | Code/work |

A key constraint is that the four chat-specific archival types — temporary memory, facts about user, permanent memory, and spacetime memory — are all guarded by a "chat mode only" check to prevent table files of the same number in code or work mode from being mistakenly processed as chat temporary memory.

The migration side also employs "importance times recency decay" scoring. An important supplementary rule is: **pragmatic activation can override temporal decay** — even if a memory is very old and its recency decay very low, it can still be recalled as long as the current topic hits it. This corresponds to the human mechanism of "retrieval cues can revive distant memories."

### 4.3.3 End-of-Day Archival Flow

End-of-day archival is a multi-step process that executes in sequence: merge the event summary and temporary memory into summary rows and key events; write the daily summary file; write the top few key events into the spacetime memory table; clear the event summary table; archive over-age "facts about user" records into the hot layer; archive remaining temporary memory in batches into the warm layer; update the warm-layer monthly index; clear the spacetime table. The cleanup phase removes old rows from the spacetime table, archives overflowing permanent memory, and finally writes all in-memory table changes to disk in a single flush. An invariant guarantees that regardless of which intermediate step fails, the final disk-write operation will execute.

The warm-to-cold migration details are: at most once per day, gated by a date stamp; migrated by entire monthly directories; uses copy-then-delete rather than atomic rename (to accommodate cross-volume scenarios; engineering records note this method may not be atomic but does not lose data); after migration, the cold-layer yearly index and warm-layer monthly index are updated, and empty directories are cleaned up.

### 4.3.4 P2 Trigger Path

The complete trigger path of P2 is: the automatic archival trigger check, upon detecting that the temporary memory table row count exceeds the threshold, first executes physical archival to write temporary memory to disk as a warm-layer batch file, then asynchronously triggers P2 summarization; internally, P2 summarization first performs a safety-fallback re-archival to ensure disk persistence, then reloads memory data (at which point the temporary memory table has been cleared), and finally runs the P2 preset to perform table edits and write the refined summary into the event summary table.

The warm-layer batch files produced by P2 archival can be retrieved by subsequent recall searches. The system also has a maintenance-layer preset that runs silently every few turns, responsible for reading the current month's conversations, calibrating the multi-axis weights used by divergence, and outputting weight and co-occurrence boost files. Its output is used preferentially by the divergence stage; this maintenance layer has no direct invocation relationship with the P2-through-P6 archival pipeline.

---

## 4.4 Dual-Line Recall Mechanism

The memory system's recall adopts a dual-line design. The two recall lines are physically isolated, each serving a distinct function: one serves "precise injection," called the native precise line; the other serves "divergence anchors," called the near-miss divergence line. The two do not reference each other — this isolation is the codification of a design red line. The comparison between the two lines is as follows:

| Dimension | Native precise line | Near-miss divergence line |
|------|-----------|-----------|
| Served object | Precise injection (memory fragments fed to the primary model) | Divergence anchors (association seeds fed to the divergence stage) |
| Hit threshold | Multi-signal scoring plus multi-word co-occurrence | Single-word hit suffices for near-miss (extremely low threshold; prefer over-recall to under-recall) |
| Output | Several fragments (default upper limit of 5) | Several anchors (default upper limit of 8; strength capped) |
| Reader | Own entry parser | Self-built reader (does not reference native recall; isolation red line) |
| Current state | Component library (not reconnected to live) | Component library (not reconnected to live; gate closed by default) |

The design rationale for the two-line separation is: precise injection requires high trustworthiness, preferring under-recall to over-recall; divergence anchors only need to provide association starting points, preferring over-recall to under-recall. If the same high-threshold recall were used to serve both, divergence would starve from anchor scarcity; if the same low-threshold were used, injection would be contaminated by noise. Hence the physical isolation into two independent channels.

### 4.4.1 Native Precise Line: Four-Dimensional Spatial Additive Scoring

The native precise line uses user input and the most recent few sentences of conversation history as the query, traverses candidate memory files, scores each memory entry along four dimensions, and ranks them to ultimately deduplicate and truncate the top entries for injection. Its end-to-end flow is: query expansion, input centroid computation, mode-isolation filtering, traversal of candidate files with entry-granularity splitting, coarse filtering by token-level co-occurrence (entries with zero query-word hits are skipped outright), followed by four-dimensional signal computation, scoring, ranking, deduplication, and truncation.

The four-dimensional scoring is spatial additive, equally weighted, and threshold-free:

```
score = semantic_dim + literal_dim + recency_dim + importance_dim
```

Each dimension is min-max normalized to [0,1] within the candidate set and then summed with equal weight. The four dimensions are:

- **Semantic dimension.** Cosine similarity between the query centroid and the entry centroid. When an entry has no word vectors (out-of-vocabulary words), this degrades to 0, and recall is purely literal.
- **Literal dimension.** Sum of inverse document frequencies of matched words, with a capping weight applied to user high-frequency words (cap at 0.3). Inverse document frequency uses the aforementioned smoothed variant.
- **Recency dimension.** Exponential decay of approximately 0.5% per hour characterizes recency: approximately 0.89 for yesterday, 0.43 for one week ago, 0.02 for one month ago.
- **Importance dimension.** Determined jointly by the layer ordinal (hot higher than warm higher than cold) and the entry weight; inferred from structure, not dependent on any nonexistent field.

Ranking is primarily by score in descending order, with the sum of semantic and hit weight as a tiebreaker; deduplication uses the complete fragment as the key, and the top entries are truncated.

A clarification explicitly annotated by the designer is required here: the current native recall implements only a simplified four-dimensional additive scoring, and is not yet equivalent to the Balanced Lexical Quotient (BLQ) algorithm framework as planned. The latter is a multi-factor algorithm framework inside the adapter, encompassing multi-factor scoring, chained cross-axis processing, multi-degree distribution, resource-library positioning refinement, and parallel cognitive mechanisms — all of which still await framework-level rewriting for integration. In other words, the four-dimensional scoring described in this section is a simplified, already-implemented subset of that complete framework.

The designer's normative statement on recall principles is: recall is matching on words; a memory entry must be simultaneously hit by two or more query words to be recalled (multi-word co-occurrence, to filter out single-word noise); query words are the union of tokenized original words and divergence words (associations, synonyms, related words); recall results are sorted by multi-signal scoring using the Generative Agents paradigm (relevance, recency, and importance — each normalized independently and then summed with equal weight). The designer's interpretation of "no magic numbers" is: each dimension undergoes min-max adaptive normalization within the candidate set, all dimensions are summed with equal weight, and no manually tuned coefficients are introduced.

The recency dimension in the four-dimensional scoring passed acceptance testing: across several hundred real conversations and cross-code/work domain samples, positive-sample hit rates improved, negative-sample suppression improved significantly, and false recall rates dropped — both axes outperformed the baseline.

### 4.4.2 Query Expansion Chain

Recall query words are not limited to the user's original words but are expanded through multiple sources: tokenization yields content words (excluding function words, ultra-high-frequency words, and retaining only content words among single characters); high-frequency hot words are activated based on user input history (drawing on the word-frequency recording approach of input method software); alias expansion; Chinese association network expansion (each word diverges into several association words); synonym expansion; contextual sentence word expansion. Among these, a targeted optimization has been applied to association divergence: only noun-type base words undergo divergence (verbs such as "understand" or "remember" do not diverge into abstract nouns, but can still be matched literally), thus cutting off sources of false recall at the divergence origin.

Literal dimension weighting handles original words and divergence words separately: original words contribute with their inverse document frequency multiplied by user word frequency weighting; divergence words additionally multiply by their association strength. Context words and synonym words have zero strength — they do not contribute literal weight, and are used only to broaden the matching surface.

### 4.4.3 Near-Miss Divergence Line: Low-Threshold Mechanism Overview

The near-miss divergence line fills the gap where divergence nodes originally "only read the most recent few sentences of conversation, without reading the three memory layers." The original divergence context recall was constrained by the designer's boundary to read only the most recent few sentences of context without reading memory data; the near-miss divergence line adds the "read the three memory layers" pathway, but explicitly serves divergence with a low threshold, separate from the native precise line. The designer's positioning of this line is: recall is the first thing; the role of the divergence stage is recall plus divergence, and its recall step is "high-volume near-miss recall, not precise."

The current mechanisms of the near-miss divergence line (prefer over-recall; low threshold) are as follows:

1. **Query word set.** The union of input words and the association word pool (limited to words of two characters or more).
2. **Per-file near-miss.** Any query word hitting a file as a substring suffices for collection — single-word hit equals near-miss. Compared to the native side's multi-signal scoring, the threshold here is extremely low, serving divergence rather than precise injection.
3. **Window word extraction.** Co-occurring words are extracted from a window of several characters to the left and right of each hit position (default 60 characters).
4. **Layer-weighted spatial additive voting.** Decreasing weights are assigned to the hot, warm, and cold layers respectively (1.0, 0.85, 0.7). Multiple-file, multiple-layer hits accumulate as multiple votes. This is spatial additive rather than multiplicative, corresponding to the design principle that "the memory pool accumulates via spatial voting, not multiplication."
5. **Two soft down-weighting paths (reduce votes, do not delete words).** First, document-frequency specificity as a continuous quantity: words appearing in fewer documents have higher specificity and weight closer to 1, while ubiquitous words approach 0 — this replaces the previous cliff-style threshold (empirically, the threshold failed to block mid-range generic words). Second, ultra-high-frequency word down-weighting: words whose corpus frequency exceeds a set threshold have their votes heavily attenuated; empirical testing showed that dead words such as common function words have corpus frequencies far higher than effective words.
6. **Known entity precise exclusion.** User names, character names, and other "dead words that the primary model could infer from bare reading" are excluded by precise matching, not by frequency guessing.
7. **Anchor output.** The top voters (default 8) are taken as divergence anchors, with strength equal to a baseline plus step times vote count, capped at 0.5.

The near-miss divergence line also has an experimental vector-based direction (for files with zero literal hits, using centroid similarity with a low threshold to retrieve), which was empirically judged negative and is closed by default (see Section 4.6).

### 4.4.4 Isolation Red Lines

The isolation of dual-line recall is ensured by two red lines.

**Red line one: the near-miss divergence line does not reference native recall.** The near-miss divergence line uses a self-built reader and does not reference the native recall module. The surface-level reason is that the native side's loading function returns a concatenated string, while the near-miss side requires a "layer plus text" shape per file; the more fundamental reason is compliance with the isolation design mandating that the divergence pipeline uses its own reader.

**Red line two: recall does not dominate divergence.** Memory anchors produced by near-miss recall enter only the divergence pool (with lower weight), not the user original-word set (with higher weight). Otherwise, a number of memory near-miss words would share the same weight as user original words, forming "recall-dominated divergence." Additionally, the strength cap on memory anchors (0.5) is lower than the strength cap on context anchors (0.7), ensuring that memory recall does not overshadow context.

Furthermore, mode isolation reuses unified private path determination, preventing other modes' private subdirectories and table files from entering the candidate set. An empirical lesson was: several session cache directories under the global layer escaped the skip rule because they lacked the underscore prefix, causing inflated average hit-file counts in work/code modes; after correcting the determination, the counts returned to normal.

---

## 4.5 Injection Mechanism Overview

The results of memory recall ultimately need to be injected into the primary conversational model's prompt. The system collects all injection content as injection items with position depth and sequence number, sorted by sequence number (lower sequence number means earlier position and higher priority).

In the current live state, the memory recall injection item is positioned after the hot layer and before chat search results. This position corresponds to a high-attention region — the design intent is to have memory recall provide real data and divergence points near the tail of the user conversation, helping the primary model avoid dead ends.

The current live-state memory injection item format is a text segment wrapped in a "memory retrieval results" marker, produced by the LLM-based retrieval preset. This is the memory recall actually running in the current production environment (see Section 4.6).

For comparison, the injection method of native recall in the component-state design must be described, to clarify the differences. Component-state native recall has three consumption paths: first, injecting recalled fragments inline into conversation history as system-role messages (gated by the warm-layer token budget); second, writing to a recall record file on disk, which the reply processor reads and mounts onto the reply's provenance information — the front end can display a collapsible provenance card; third, appending behavioral signals to each hit for use by self-optimizing layering. Component-state self-driven divergence output follows a separate injection item at an earlier position. Both differ from the current live-state injection method — **current production uses LLM-based retrieval injection, not the component-state inline injection.** This distinction is key to understanding the "component state versus live state" layering of this memory system.

---

## 4.6 Empirical Results

### 4.6.1 Current Live-State Declaration

This section begins by reiterating the most important implementation status declaration to prevent misreading: the self-driven recall and native recall of this memory system are **both in component state** (implemented, isolated, not reconnected to the main pipeline); **the current live state runs the LLM-based retrieval preset.** The designer's decision on this matter is explicit: the not-yet-complete self-driven recall and divergence were moved from the main pipeline to documentation archives and temporarily disabled.

The current live pipeline is: the user sends a message, which enters the prompt processor; the self-driven sufficiency flag is permanently false, so the LLM-based retrieval preset runs unconditionally, producing memory retrieval injection. The three component-state recall modules — native recall, self-driven pipeline, and near-miss divergence recall — currently have no production callers, are protected by default-off gates, or are only referenced by test scripts.

Two known pitfalls when reconnecting these components: first, the archived block contains its own sufficiency flag declaration with the same name as the main file's, and inserting it as-is would cause a duplicate declaration error — one must be chosen; second, the archived block references native recall, violating the isolation red line — reconnection must use the self-built reader instead (which has already been implemented in the near-miss divergence line). The isolation red line is permanent: the divergence pipeline does not reference native recall, and its output enters only the divergence injection item.

It should be clarified that the LLM-based retrieval preset currently running in the live state has mature prompts across all three modes with no contract misalignment, and is in a "do not touch" stable state; the component-state algorithms discussed in this chapter are a parallel, awaiting-reconnection implementation.

### 4.6.2 Historical Recall Archaeology

An archaeological study clarified the statement that "previously only AIRP (anime/game creative) mode recall was implemented." The prior recall refers to the complete memory recall system of the old monolithic version (a single file of approximately two thousand lines), using substring recall plus five-dimensional weighted linear scoring, which was deactivated along with the fast-track removal. The evidence for "only AIRP was done" is: in the old monolith's divergence code, there existed a section effective only in the anime/game creative mode — a "work-to-technique divergence" that matched input words against a technique mapping table of over a hundred classic works, outputting corresponding techniques, scenes, and atmosphere words. Other modes lacked this "memory reference to professional output" dedicated pathway. This pathway was a half-implemented feature: the main file contained its consumer-side filter conditions, but the producer side never existed in any historical snapshot — only the consumer side was ever written since its inception. Its design origin was a concept from the designer: originally intended for anime/game creation, if it could be generalized, it might enable self-association in code and work modes.

### 4.6.3 Near-Miss Divergence Line Empirical Results

On two hundred real samples (fifty per mode), the near-miss divergence line was compared before and after mode isolation took effect. Using average hit-file count as the metric:

| Mode | Before isolation | After isolation |
|------|--------|--------|
| Work | 53.4 | 36.8 |
| IDE | 64.5 | 45.9 |
| AIRP | 51.4 | 27.1 |
| Chat | 21.2 | 9.1 |

After isolation took effect, the voting magnitude dropped from the fifties to single digits or low teens; specificity weighting took effect; user names and character names were completely removed from the rankings; 193 out of 200 examples produced anchors, and 186 out of 200 had changes in divergence output. Case-by-case reading showed that the recall could retrieve high-specificity concrete memory words, and layer distribution also matched expectations (e.g., when querying about memories from a long time ago, hits skewed toward the cold layer). This near-miss divergence line is the current solution, currently closed by default, pending formal promotion.

### 4.6.4 Vector Near-Miss Experiment Judged Negative

An experimental vector direction of the near-miss divergence line (using centroid similarity with a low threshold to retrieve files with zero literal hits) was judged negative after two-hundred-sample testing and is closed by default. Its failure mode was the "catch-all-ification" of generically matching words — words such as "don't want," "project," and "plan" appeared frequently yet with semantic drift. The root cause was: file-level centroid averaging blurred specificity, violating the design principle of "do not take averages in order to preserve tension"; moreover, the vector path bypassed inverse document frequency, allowing generic words to flow back. This direction is not entirely without value — on queries with sparse literal hits (e.g., "what are the plans for next week"), vectors could retrieve files that were semantically correct but impossible to hit literally. The lesson derived is: literal near-miss anchors carry window-based contextual evidence from matched words, while vector near-miss anchors only have overall proximity — evidence granularity determines anchor quality.

### 4.6.5 Divergence-Side Lexicon Campaign and Four-Mode Rating

Also strongly associated with the AIRP mode is a divergence-side lexicon review. That mode's narrative lexicon once dominated due to excessive proportion, leading to catch-all-ification (several narrative trope words appeared constantly). After multiple rounds of root-cause analysis and closure, all old catch-all terms exited the rankings, multi-axis distribution rebalanced, and the mode achieved zero regression after lexicon closure.

Case-by-case reading of the actual divergence output for four modes (twenty-four examples) yielded an AIRP mode rating of medium: good fit for genuine role-play inputs (producing subtle emotional expressions, character arcs, and specific work-related words) and appropriate directions for poetic inputs; however, a meta-conversation noise problem exists — for inputs discussing functionality and other non-role-play topics, the mode lacks protection and still outputs romance narrative words regardless.

### 4.6.6 Real Output Samples

The preceding sections summarized empirical conclusions through statistical metrics and ratings. This section further provides several representative real input-output samples in Listing format, showing the complete chain of "input → system's actual recall/divergence/injection output → judgment." All samples are verbatim from experimental records without rewriting; personal information is anonymized with [name]. Samples fall into three categories: near-miss divergence hits, vector direction judged negative, and four-mode divergence output. All experiments were conducted in July 2026. The near-miss and vector sample sizes were two hundred (fifty per mode); the four-mode divergence category comprised twenty-four case-by-case readings.

**I. Near-miss divergence line hit samples.** The following two examples are from case-by-case reading after mode isolation took effect on the near-miss divergence line, demonstrating how the low-threshold near-miss retrieves high-specificity concrete memory words from the three memory layers, and how layer distribution shifts with the temporal orientation of queries.

> **Listing 4-1 (Near-miss divergence hit)**
> Input: A routine conversational query.
> System's actual near-miss recall anchors: `banana`, `gripe`, `virtual space`.
> Judgment: All three words are high-specificity concrete memory words, not generic dead words, and can serve as effective association seeds for the divergence stage.

> **Listing 4-2 (Near-miss divergence hit with layer distribution)**
> Input: `Do you remember February...` (pointing to memories from a long time ago).
> System's actual recall: The layer distribution correctly skewed toward the cold layer (12 out of 22 hits in the cold layer), retrieving high-specificity memory words such as `strawberry` and `stubborn`.
> Judgment: When the query explicitly points to memories from a long time ago, hits naturally tilt toward the cold layer, corroborating the design expectation of the three-layer structure that "keyword trigger escalates deep retrieval to the cold layer"; the retrieved anchors are also concrete memory words rather than generic words.

The above two examples demonstrate that after mode isolation and specificity down-weighting took effect, the near-miss divergence line can stably retrieve high-specificity words relevant to the query context, and layer distribution aligns with the temporal orientation of the query.

**II. Vector near-miss direction negative-judgment samples.** The following two examples are a failure sample and a success sample of the vector direction (using file-level centroid cosine similarity with a low threshold to retrieve words), which together delineate the boundary of "evidence granularity determines anchor quality" for this direction.

> **Listing 4-3 (Vector direction failure sample)**
> Phenomenon: Generic matching words became "catch-all." `don't want` hit in 23 out of 100 examples, `project` in 14, `plan` in 10.
> Typical drift: `don't want` made a pure semantic drift hit against an IDE-mode memory text "long press to display 'please enter a valid value.'"
> Judgment: File-level centroid averaging blurred specificity, and the vector path bypassed inverse document frequency, causing generic words to flow back and leading to high-frequency false matching of generic words. This was the direct basis for the negative judgment.

> **Listing 4-4 (Vector direction success sample)**
> Input: `Any plans for next week?` (literal hits on only seven files).
> System's actual recall: The vector direction retrieved twenty-nine files; anchors were `planning`, `schedule`, `future`, `plan`, `approach`.
> Judgment: On queries with sparse literal hits, vectors could retrieve files that were semantically correct but impossible to hit literally; anchors hit the semantic field squarely. This shows the vector direction is not entirely without value — its failure root cause lies in evidence granularity, not the direction itself.

Synthesizing both examples yields the core lesson from the experimental records: literal near-miss anchors come with window-based contextual evidence from matched words, while vector near-miss anchors have only overall proximity — evidence granularity determines anchor quality. This direction was closed by default because the failure cases dominated.

**III. Four-mode divergence output samples (AIRP mode).** The following samples are from the case-by-case reading of four-mode actual divergence output, focusing on the AIRP mode's real divergence word output under different input types, to support the judgment of "medium rating" for this mode.

> **Listing 4-5 (Good fit for role-play input)**
> Input: `Scolding you means I still care` (genuine role-play input).
> System's actual divergence output: subtle emotional expression narrative, rekindled romance.
> Judgment: Good fit for genuine role-play input; able to produce a subtle emotional expression direction.

> **Listing 4-6 (Direction correct but imprecise)**
> Input: `Post-apocalyptic world, don't know how to build the worldview`.
> System's actual divergence output: worldview-centric narrative, framework narrative, visual atmosphere creation.
> Judgment: Direction correct, but missing the direct-hit word "worldview construction," reflecting that this mode still has room for improvement in specific hit words.

> **Listing 4-7 (Meta-conversation noise: lack of protection)**
> Input: `Do you have any features you want added? I'll work on it` (a non-role-play input discussing functionality).
> System's actual divergence output: perceived betrayal, marriage of convenience, sweet encounter.
> Judgment: When facing meta-conversation (out-of-character) input, the mode lacks protection and outputs romance narrative words regardless. This is the key deficiency underlying its medium rating.

Juxtaposing the three examples reveals: the AIRP mode fits well for genuine role-play and poetic inputs, but has no protection against meta-conversation input and outputs romance narrative words regardless — this is precisely the empirical basis for the "medium rating" described in Section 4.6.5.

### 4.6.7 Recall Capability Grading: What Level of Retrieval Can Be Achieved

The preceding sections reported the isolation effect of the near-miss divergence line, the negative judgment of the vector direction, and the four-mode divergence rating through metrics and samples respectively. This section converges on a more fundamental question from an orthogonal dimension: **what level of retrieval can this recall system actually achieve** — how deep a memory layer it can reach, how large a hit volume it can cover, and how far back in time it can recall. This question is critical because the recall level directly determines the stability of the dynamic context injected into the primary conversational model: recall that stably reaches the cold layer and stably retrieves high-specificity anchors is what provides non-drifting pre-positioned anchors for divergence (the argument closure is at the end of this section).

The data in this section comes from the same batch of experiments as Sections 4.6.3 and 4.6.6: July 2026, two hundred real samples (fifty per mode), batch-run by the near-miss divergence line after mode isolation and specificity down-weighting took effect. Each example was white-box recorded for scanned file count, hit file count, per-layer hit distribution, and per-anchor layer source and vote value. It must first be declared that this C3 data recall line was in gray-scale off state by default at the time; what this section reports is its component-state batch test behavior, not current live-state production behavior (the current live state runs the LLM-based retrieval preset; see Section 4.6.1).

**I. Layer dimension: three-layer reachability and actual layer distribution.** The three memory layers (hot-layer active memories, warm-layer approximately one-month history, cold-layer memories older than one month; see Section 4.2) were all stably reached in this batch of experiments. Using cold-layer hit as the reachability criterion, the cold-layer reach rate across two hundred examples was: AIRP mode — all fifty examples reached the cold layer; IDE and work modes — forty-nine examples each reached it; chat mode — forty-two examples reached it. That is, on the vast majority of queries, recall was able to penetrate to the cold layer — "older than one month, requiring keyword trigger for escalated deep retrieval" — rather than staying only in the always-read hot layer.

The actual shape of single-example layer distribution (layerDist) is illustrated: for the first example in chat mode, the layer distribution was hot:3, warm:1, cold:2; for an example querying about an older memory (see Listing 4-2 in Section 4.6.6), cold-layer hits accounted for 12 out of 22, with the center of hits clearly skewed toward the cold layer. This corroborates the design expectation of the three-layer structure — "keyword trigger escalates deep retrieval to the cold layer" — in that layer distribution adaptively tilts with the temporal orientation of the query rather than being fixed to any single layer.

**II. Scale dimension: magnitude of single-scan and hit volumes.** White-box fields recorded the number of files scanned per recall (scanned), literal hit file count (hitFiles), and vector-direction hit file count (vecHitFiles). The average hit-file count (avgHitFiles) across four modes after mode isolation took effect was: chat 9.1, work 36.8, IDE 45.9, AIRP 27.1 (the same dataset as Section 4.6.3, reused here from the perspective of "how large a volume can be hit"). In terms of the single-example upper bound of reachable scale, the highest single-example hit in this batch was sixty-seven files for IDE mode, fifty-three for work, thirty-five for AIRP, and twenty-three for chat; among these, the deepest single-layer cold-layer reach per example was twenty-four files in work, IDE, and AIRP modes, and eighteen files in chat mode. This scale corroborates the near-miss divergence line's positioning of "prefer over-recall; high-volume near-miss recall" — recall does not retrieve just a handful of entries but can scan across three layers and produce dozens of hit files in a single query, which are then converged by layer-weighted voting and specificity down-weighting into the top few anchors.

**III. Temporal span dimension: how far back can content be recalled.** Temporal span is indirectly bounded by the layer definition: the cold layer stores memories older than approximately thirty days (see Sections 4.2 and 4.3.2 for the warm-to-cold migration threshold). Therefore, the cold-layer reachability described above constitutes evidence that "recall can reach history beyond thirty days" — across four modes, nearly every example reached cold-layer memories beyond thirty days, and as shown in Listing 4-2, when the query explicitly points to a distant time ("Do you remember February..."), hits naturally concentrate in the cold layer. An evidence boundary must be honestly noted: the per-example white-box results of this batch recorded per-layer hit distributions, but did not export the raw date stamp of each hit memory per example. Therefore, this section uses "cold layer (beyond thirty days) can be stably reached" as the lower-bound evidence for temporal span, and does not claim to have empirically verified a specific maximum recall date.

**IV. Real recall content samples: inputs, layers, hit anchors, and vote values.** The following samples are verbatim from the per-example white-box results of this batch, showing the complete form of "input → actual recalled anchors (with layer source and vote value)." Anchor notation is "word (vote value, layer source)," where vote value is the result of layer-weighted spatial additive voting after specificity down-weighting, and layer source indicates which layers the word was hit in. Personal information is anonymized.

> **Listing 4-8 (Chat mode, three-layer simultaneous hit)**
> Input: A chat-mode daily query (English colloquial, with emotional expression).
> Hit scale and layer distribution: 12 files hit; hot:3, warm:2, cold:7.
> Actual recalled anchors: `character` (1.77, warm+cold), `table` (1.77, warm+cold), `trait` (1.7, warm), `strawberry` (1.4, cold), `memory` (1.36, cold+warm), `mechanism` (1.2, cold), `pointed out` (1.2, cold), `moving house` (1.2, cold).
> Judgment: Even with an English colloquial input with no explicit temporal orientation, recall penetrated to the cold layer to retrieve high-specificity concrete memory words such as `strawberry` and `moving house`. Most anchors have cross-layer sources, and vote values form a gradient by specificity.

> **Listing 4-9 (Work mode, deep cold-layer reach)**
> Input: A work-mode long-context query (containing terminology explanations and tool descriptions).
> Hit scale and layer distribution: 53 files hit; hot:10, warm:19, cold:24 — one of the deepest single-layer cold-layer reaches in this batch.
> Judgment: A long query in work mode can scan dozens of hits spanning all three layers in a single pass, with the cold layer alone reaching twenty-four files, demonstrating that recall maintains deep-layer reachability under long context rather than being swamped by recent hot-layer entries.

> **Listing 4-10 (AIRP mode, cold-layer dominant, high-vote anchors)**
> Input: A role-play long input (containing character settings and narrative).
> Hit scale and layer distribution: 30 files hit; hot:8, cold:22.
> Actual recalled anchors (top entries): `memory` (4.61, cold+hot), `sharing` (3.35, cold), `permanent` (2.86, cold), `name` (2.79, cold+hot), `virtual space` (2.77, cold), `confirmation` (2.68, hot+cold), `strawberry` (2.58, cold+hot).
> Judgment: The input contained self-descriptive statements spanning long-term history such as "approximately one hundred sixty modifications since inception." Recall accordingly had the cold layer as the dominant anchor source (22 out of 30), and high-vote anchors `memory`, `permanent`, and `virtual space` all hit the cold layer, with a significant vote-value gradient. This demonstrates that when semantic orientation points to long-term history, recall can stably use cold-layer memories as the primary anchors.

> **Listing 4-11 (AIRP mode, cross-layer high-specificity anchors)**
> Input: A role-play input containing character personality descriptions.
> Hit scale and layer distribution: 29 files hit; cold:22, hot:7.
> Actual recalled anchors (top entries): `name` (4.56, cold+hot), `strawberry` (4.33, cold+hot), `devoted` (4.3, cold+hot), `stubborn` (4, cold+hot), `claimed` (4, hot), `took away` (4, hot), `left for` (4, hot), `developer` (4, hot).
> Judgment: Cross-hot-cold-layer high-specificity words such as `strawberry`, `stubborn`, and `devoted` form the top anchors, consistent with Listing 4-2's description of "older memory query retrieving strawberry, stubborn." This corroborates that the same batch of concrete memory words can be stably and reproducibly recalled across different role-play queries.

> **Listing 4-12 (IDE mode, warm-layer dominant)**
> Input: `Record md, then update project diagram and flowchart` (a short engineering-operation query).
> Hit scale and layer distribution: 56 files hit; warm:31, hot:7, cold:18.
> Actual recalled anchors (top entries): `date` (8.15, warm+cold), `negation` (4.29, warm+cold), `architecture` (4.29, warm+cold), `user` (4.18, warm), `task` (4.18, warm), `record table` (4.18, warm).
> Judgment: An engineering-type query has its center of hits in the warm layer (recent episodic memory); high-vote anchors `architecture`, `task`, and `record table` match the engineering context. Layer distribution shifts from cold-layer dominant for "personal long-term memory" to warm-layer dominant as the query semantics switch to "recent engineering items."

Juxtaposing the above five examples reveals: the reachable layer, hit scale, and layer distribution of recall are not fixed but adapt to the temporal orientation and context of the query — queries pointing to long-term history anchor primarily on the cold layer, engineering near-term items anchor primarily on the warm layer, and the cold layer can be reached in nearly all queries. This adaptive deep reachability is the empirical foundation for the argument closure below.

**V. Argument closure: recall level determines dynamic context stability.** The three-dimensional data on layers, scale, and temporal span in this section jointly support an argument running throughout the chapter: the level of recall — how deep a layer can be reached, how large a scale can be covered, how far back content can be recalled, and whether high-specificity rather than generic anchors can be stably retrieved in this process — directly determines the stability of the dynamic context subsequently injected into the primary conversational model. If recall is shallow, stopping only at the hot layer, or if retrieved words are all generic words like common function words, then the injected context per turn will drift with query perturbations, and divergence will lose reliable pre-positioned anchors. Conversely, the recall level demonstrated in this section — "cold layer stably reached, cross-layer high-specificity anchors stably reproduced" — is precisely the fundamental reason for using recall as a pre-positioned anchor for divergence. This is consistent with the positioning stated in Section 4.4.3: "recall is the first thing; the role of the divergence stage is recall plus divergence" — recall first contracts on trustworthy anchors from deep memory, and divergence then expands outward from these anchors without drifting.

Three boundary conditions must be honestly noted to avoid overclaiming: first, the data in this section comes from component-state batch testing, and this C3 data recall line was in gray-scale off state by default at the time — this is not current live-state behavior; second, the two hundred examples were a mixed run across four modes, with no independent recall positive acceptance test for AIRP mode alone (see the honest gap in the next section); third, the temporal span dimension uses "cold layer (beyond thirty days) can be stably reached" as the lower-bound evidence, without exporting a specific maximum recall date per example.

### 4.6.8 Empirical Summary and Honest Gaps

The above experiments fairly comprehensively covered six areas: historical archaeology, near-miss divergence line mode-isolation testing, vector direction negative judgment, divergence-side lexicon campaign, four-mode rating, and recall capability grading. One honest gap must be noted: no independent positive acceptance test for "AIRP mode-specific three-layer memory recall effectiveness" has been found — the near-miss divergence line is currently closed by default and has not been formally promoted; it was tested in batch alongside the other three modes, with no standalone recall deployment effectiveness conclusion for that mode. The old monolith's work-reference pathway, with its consumer side present but producer side absent, is a half-implemented feature; its reconnection is a pending candidate item.

---

## 4.7 Summary

This chapter described the memory subsystem of the external Divergence & Recall thought-chain system. Its design foundation is the designer's independent understanding of human transient memory, conscious memory, and memory formulas; academic labels such as the multi-store model and the forgetting curve are post-hoc correspondence indices rather than design blueprints. The data layer is organized by character with a four-layer structure (table layer plus hot, warm, and cold layers); entries are split down to individual-entry granularity; the three modes are isolated in tables and private spaces while sharing the three memory layers. The memory processing pipeline uses a set of numbered presets for archival consolidation, most of which are disabled by default with actual archival handled mechanically — only the table summary preset participates automatically. Recall adopts a dual-line design: the native precise line uses four-dimensional equally-weighted spatial additive scoring for precise injection, while the near-miss divergence line uses low thresholds, layer-weighted voting, specificity down-weighting, and entity exclusion for divergence anchors — the two are physically isolated and recall does not dominate divergence. The injection mechanism places recall results at a high-attention position.

A key declaration running throughout the chapter is: the native recall and self-driven recall pipelines described above are currently both in component state — implemented and isolated but not yet reconnected to the production main pipeline; the current live state runs the LLM-based retrieval preset. Therefore, this chapter describes a set of implemented, awaiting-reconnection memory algorithm component libraries. Empirical results show that the near-miss divergence line significantly improved after mode isolation, the vector direction was verified negative, and the divergence-side lexicon was stabilized through remediation — but several pending promotion and acceptance items remain open.
