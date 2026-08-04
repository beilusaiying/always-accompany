# Plugins Are Not a Menu: Compose an Outcome

Read as a flat list, Beilu can look like a pile of features. Its real difference appears when memory, tools, perception, rendering, modes, and permissions share one message pipeline.

You do not need to learn everything before starting. Pick one problem you have now, enable the smallest combination that solves it, and add another layer only after the first one is already useful.

## What can it replace in my current workflow?

| What you do now | Smallest replacement | What changes | What you still decide |
|---|---|---|---|
| Paste old chats into every request | memory + P1 | Memory persists, relevant items can be recalled, and the current turn can show what it used | What to store, whether P1 runs, whether the recall is appropriate |
| Chat in a character frontend, then switch to an unrelated IDE assistant | Chat/Code/Work + memory + preset | The same persona, memory, and editable prompt system can participate in different work modes | What modes share and what they isolate |
| Ask a web-enabled model for summaries but cannot act on the page | web + browser + files | Find sources, operate a real browser, and leave an artifact in the workspace | Login sessions, downloads, and write scope |
| Lose local tools whenever the IDE is closed | files + CLI | Provide a workspace-constrained tool backend without requiring an IDE | Workspace root, command permissions, and startup policy |
| Copy live-chat questions into an AI by hand | live + preset + memory | Deterministic filtering selects input before it enters the existing main chat pipeline | Platform credentials, carrier chat, pacing, and model cost |
| Maintain character state in one giant prompt | worldbook + MVU + EJS/regex + AIRP | Lore, state, logic, and rendering become separate editable layers | State ownership, script trust, and render fallback |
| Write custom glue to insert local-program output into prompts | plugin-host + your program | A controlled host can return short-lived injections or tool results | Subprocess permission, token, TTL, and errors |

## Six combinations you can evaluate directly

### 1. Long-term companionship: manageable memory, not “infinite context”

**Combine:** memory + P1 + preset + worldbook; add AIRP/MVU only when you want scene presentation.

```text
conversation creates facts
  → memory tables / hot layer / archives persist them
  → P1 recalls candidates for the current topic
  → presets and worldbooks add identity, rules, and lore
  → the main model replies
  → the recall trace shows which memories were used this turn
```

This can replace repeatedly pasting old conversation or relying only on a huge context window. It does not make every stored memory correct. P1 is disableable; the current Chat, Code, and Work routes use self-driven P1, while other modes may use a different route.

### 2. Local coding: chat, tools, and project history in one chain

**Combine:** Code + files + CLI or YonBan + memory; add web/browser for external research.

CLI is useful when you want tools from the main application without an IDE. YonBan is useful when IDE UI and extension integration matter. They are alternative execution backends, not a reason to run every tool at once.

### 3. Research and deliverables: leave a file, not only an answer

**Combine:** Work + web + browser + files; add PPT for a presentation.

Search discovers candidates, the browser handles dynamic pages or real interaction, and files preserve sources, drafts, and deliverables inside a chosen workspace.

### 4. Live interaction: reuse the main chain

**Combine:** live + Chat/Live mode + preset + memory; add eye when the screen or game is also an input.

The live plugin does not invoke the model once per message. It filters by length, blacklist, keywords, cooldown, and deduplication; selects a batch from a pool; then sends one context block through the existing main generation path.

### 5. Interactive narrative: separate content, state, logic, and display

**Combine:** worldbook + MVU + toggle + EJS + regex + AIRP.

- worldbook owns lore and activation rules;
- MVU owns cross-turn variables;
- toggle activates and deactivates entries;
- EJS adds conditions and templates;
- regex performs deterministic post-processing;
- AIRP renders the scene.

The value is that each layer can be edited, replaced, or disabled independently.

### 6. Minimal network surface: local where useful, external only when chosen

**Combine:** memory + P1 + STT; add web, browser, vectordb, or an external AI service only when the task needs them.

“Local” does not mean all data can never leave the machine. An embedding endpoint receives text to embed; the selected AI service receives the final prompt; web and platform plugins contact their respective services. Composition makes these boundaries selectable, not nonexistent.

## A practical learning order

1. Learn mode switching and plugin master switches.
2. Pick one minimal combination above.
3. Inspect one real input, output, and status view.
4. Then edit presets, memory, or permissions.
5. Leave EJS, user subprocess plugins, and complex automation for later.

If a combination cannot help you complete one small real task within a short trial, remove plugins before adding more.

Continue with [Plugin Overview](overview.md), [Memory](../memory/overview.md), [Semantic Search](vectordb.md), [CLI](cli.md), [Live Input](live.md), or [Security](../security/overview.md).
