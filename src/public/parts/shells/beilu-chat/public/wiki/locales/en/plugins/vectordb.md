# Semantic Search (beilu-vectordb)

beilu-vectordb adds full-text, vector, and hybrid search to memory files. It helps when wording changes but meaning stays close. It is not a newer generation of P1, and it does not gain vector capability without configuration.

## When to use it

Use it when you have many paraphrases, a trusted OpenAI-compatible embedding service, and are willing to pay the API, index, and rebuild cost.

You may not need it when keywords/worldbooks are sufficient, no memory text may leave the machine and you lack a local embedding service, or you only want self-driven P1.

## Default state

- The plugin is present and appears in the new-user defaultParts list.
- Vector semantic search is **off by default**.
- API URL and key are empty.
- Current code defaults to model text-embedding-ada-002 and 1536 dimensions, but your service must determine the real values.
- “Loaded” does not mean indexReady.

Configure it in [Plugin Management](beilu:settings/plugins):

| Setting | Meaning | Current default |
|---|---|---|
| enabled | Enable semantic search | false |
| embeddingApiUrl | OpenAI-compatible /v1/embeddings endpoint | empty |
| embeddingApiKey | API key | empty |
| embeddingModel | Provider model identifier | text-embedding-ada-002 |
| embeddingDimensions | Actual vector dimensions | 1536 |
| topK | Maximum returned results | 10 |

## Data and privacy

    Memory text
      ↓ chunking
    Your configured embedding API
      ↓ vectors
    Orama index
      ↓
    <character memory>/_vector/index.json

Global plugin configuration is stored at:

    data/plugins/beilu-vectordb/config.json

If the endpoint is remote, relevant memory chunks leave the machine. Do not expose the API key. Changing model or dimensions can invalidate the persisted index and require a rebuild.

## Search modes

| Mode | Signal | Useful for |
|---|---|---|
| fulltext | Query terms | Names, terms, quoted clues |
| vector | Query and document embeddings | Paraphrases and semantic neighbors |
| hybrid | Both | Exact and semantic matching together |

If query embedding fails in hybrid mode, the implementation records a diagnostic and falls back to full-text. Pure vector mode returns an explicit error. Do not report the fallback as a successful vector query.

## Index lifecycle

- Real writes may incrementally enter the index through the memory vector bridge.
- An empty index does not secretly trigger a full rebuild on the first query.
- Full rebuild is explicit and requires a memory directory.
- Each character-memory partition persists its own _vector/index.json.
- Model or dimension mismatches should be fixed, then rebuilt—not hidden by padding or truncation.

## Vector search vs self-driven P1

| Vector DB | Self-driven P1 |
|---|---|
| Primarily lexical and embedding similarity | Direct terms, concept relations, associative directions, time, and mode |
| Requires an embedding service for vectors | No LLM/embedding API per recall, but local resident services |
| Strong candidate for paraphrase retrieval | Candidate for indirect clues and associative recall |

They can coexist, but no external same-corpus, gold-labeled benchmark currently proves that the combination is always better.

## Troubleshooting

- **enabled but indexReady=false:** verify API, model, dimensions, errors, and run an explicit rebuild or wait for real incremental writes.
- **dimension mismatch:** configure the actual model output dimensions.
- **zero results:** inspect enabled state, document count, character partition, mode, endpoint errors, and layer filters.

## Continue

- [Memory System](../memory/overview.md)
- [Current P1 Runtime (Chinese evidence chapter)](../../../p1-recall/ch7-current-runtime.md)
- [Plugin Manual](overview.md)
