# Memory System

Beilu memory is not one search box and not a vector store containing every chat. Several chains have different responsibilities:

- **Record and structure:** write people, events, preferences, tasks, and state into editable tables or files.
- **Layer and archive:** keep recent material easy to use while preserving older source data outside the active context.
- **Recall for this turn:** P1 finds old material from current clues.
- **Explicit triggers:** worldbooks inject stable background from keywords and rules.
- **Optional semantic search:** beilu-vectordb provides full-text, vector, and hybrid retrieval.
- **Traceable consumption:** a reply can show which recalled records actually participated in the turn.

The goal is to preserve enough of the past without sending all of it to the model every time.

## What you experience

- You do not need to reintroduce a character whenever the current window loses old messages.
- Context cleanup reduces what is sent now; it does not mean deleting the source records on disk.
- Memory remains inspectable and correctable instead of becoming hidden model state.
- A “memories used this turn” card exposes the recalled records attached to a reply.

## Where memory lives

The memory root is scoped by user and character, with mode-specific data below it:

    data/users/<user>/chars/<character>/memory/
      ├─ character and chat memory
      ├─ hot / warm / cold archive layers
      ├─ code/
      │   ├─ active/
      │   ├─ archive/
      │   └─ projects/
      ├─ work/
      │   ├─ active/
      │   ├─ archive/
      │   ├─ outputs/
      │   └─ workflows/
      └─ _vector/
          └─ index.json

Exact directories can change during migrations. Use the current memory panel and implementation as authority; do not bulk-move memory files without understanding indexes and archives.

## P1: retrieving the past for this turn

### Three route states

| Route | Meaning | Current declared default |
|---|---|---|
| Self-driven P1 (10) | Local algorithmic recall without an LLM call per retrieval | Chat, Code, Work |
| AI P1 (01) | Older AI retrieval route kept as a mutually exclusive alternative | Smart, Bot |
| Off (00) | No P1 for this mode | User-selectable |

Self-driven P1 and AI P1 cannot run together, and both may be disabled. A plugin-level master switch sits above the per-mode routes.

### Current self-driven path

    Current message with user, character, chatId, and mode
      ↓
    Plugin master switch + per-mode route
      ↓
    P1 bridge and service runtime
      ↓
    Node0–4: clues, candidates, associative directions, filtering, convergence
      ↓
    Recalled records → INJ-p1-retrieval-data
    Direction words  → INJ-p1-act-data

Physical source caches may be shared to avoid repeated loading, but candidates, ranking, and injection results must retain their chatId and window ownership.

### Measured boundary

In one 2026-08-03 backend white-box run, a Chinese hit request took about 560.9 ms. A later full-process-tree measurement peaked around 2054.5 MiB, failing a strict 2 GiB gate.

These measurements prove a path and expose a cost; they are not stable benchmarks. A release-quality report still needs cold, warm, P50, P95, repeated memory peaks, and gold-labeled Recall@k, MRR, nDCG, and failures.

Therefore the project should not advertise “millisecond recall” without the cold-start boundary, or turn unlabeled internal samples into a “90% recall rate.” See [Current P1 Runtime (Chinese evidence chapter)](../../../p1-recall/ch7-current-runtime.md).

## P2–P8 are not a default feature checklist

| Module | Intended role | Current public status |
|---|---|---|
| P2 | AI summarization and long-term refinement | Background automatic trigger stopped; manual-button path has a known early-return issue |
| P3–P6 | Higher-level organization, reflection, compression, and format maintenance | Not part of the default new-user route; verify presets and triggers individually |
| P7 | Coding-memory preset | Templates and mode storage exist, but file presence alone does not prove a stable full chain |
| P8 | Web-search-related preset | Actual behavior depends on enablement, prompts, and a working service path |

Mechanical archives, table migration, and AI summarization are separate mechanisms.

## Vector search is not a replacement generation of P1

beilu-vectordb uses Orama for full-text, vector, and hybrid search. Vector functionality is off by default and requires an OpenAI-compatible embedding endpoint, model, and dimensions. Memory text is sent to the endpoint you configure.

| Route | Primary signal | Useful for |
|---|---|---|
| Worldbook | Explicit keywords and fixed content | Rules, lore, and information that must be injected |
| Full-text | Lexical overlap | Names, terms, and quoted clues |
| Vector | Embedding similarity | Paraphrases and semantic neighbors |
| Self-driven P1 | Direct terms, concept relations, associations, time, and mode | Indirect clues and multi-stage associative recall |
| Large context | Recent source messages | Continuous work while details still fit |

These routes can be combined, but there is not yet an external comparison on identical corpora and gold labels. See [Semantic Search](../plugins/vectordb.md).

## How it differs from common memory / RAG choices

### If you only need an SDK

A general memory SDK is usually easier to embed in an existing application. Beilu is heavier because it also supplies characters, UI, modes, prompts, tools, safety, and persistence. Choose it for that combination, not for one endpoint.

### If you already have a vector database

Beilu additionally addresses who wrote a memory, which layer owns it, which modes may read it, when it archives, how retrieval enters the prompt, and how users inspect and correct it.

### If you rely on large context

Large context preserves recent detail; layered memory preserves and retrieves long history. They can work together.

### If you use manual summaries and worldbooks

They remain useful, controllable mechanisms. Beilu puts explicit rules, structured facts, and associative recall into separate roles instead of pretending one technique solves all memory problems.

## Operating principles

1. Disk data is the truth source; panels, caches, and indexes must be checkable against it.
2. Separate users and characters before sharing anything.
3. Shared identity does not permit Code or Work task state to leak across windows.
4. Verify writing and retrieval independently.
5. Treat archiving and deletion as different operations.
6. After editing memory, verify actual consumption on a later turn.

## Continue

- [Memory Presets](presets.md)
- [Hot Memory](hot-layer.md)
- [Archival](archival.md)
- [Memory Tables](tables.md)
- [INJ Overview](inj-overview.md)
- [Worldbooks](worldbook-overview.md)
- [P1 Recall](../p1-recall/preface.md)
- [Semantic Search Plugin](../plugins/vectordb.md)
