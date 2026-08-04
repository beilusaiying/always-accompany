# PPT Generation (beilu-ppt)

beilu-ppt turns a natural-language request into a real pptx file, page previews, and an iterative editing loop. It participates in Work and Code modes, not ordinary Chat.

## Workflow

    Your request
      ↓
    AI proposes an outline
      ↓
    You approve or revise the structure
      ↓
    The plugin generates pptx + page previews
      ↓
    You request page-level or deck-level changes
      ↓
    The plugin regenerates the output

The AI can combine outline, generation, single-page adjustment, whole-deck editing, chart fitting, and image search. You can interact through normal requests instead of selecting each internal step.

## Outputs

| Output | Purpose |
|---|---|
| pptx | Deliverable editable in Office or WPS |
| PNG previews | Inspect pages directly in the conversation |
| ASCII layout preview | Lightweight layout feedback for the AI |

Repeated iterations use overwrite semantics for the same output rather than producing an unlimited pile of identically named files.

## Loop controls

- A per-turn operation budget limits how many PPT actions the AI may run.
- Identical repeated operations are rejected.
- If the budget is exhausted, give new guidance in the next user turn.

These controls prevent generate → dislike → regenerate loops from running indefinitely.

## Deployment and permission

- **Local deployment:** the built-in Python pipeline is allowed by the local-owner default.
- **Server deployment:** execution is blocked by default. The instance owner must explicitly enable allowPptPipeline or BEILU_PPT_PIPELINE=on.
- A working local Python environment is required.

Do not describe a blocked server pipeline as a generation failure; inspect the owner safety gate first.

## Continue

- [Plugin Manual](overview.md)
- [File Operations](files.md)
