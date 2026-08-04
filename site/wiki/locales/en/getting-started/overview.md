# Welcome to always accompany

always accompany is a local, editable AI system. It connects long-term memory, multiple operating modes, tool plugins, and permission controls in one runtime chain.

You can use it only for conversation and companionship, or continue into Code, Work, Bot, IDE, browser, MCP, and user plugins to shape your own AI.

## Decide whether it fits first

| Your goal | What Beilu changes |
|---|---|
| Keep talking with one character over time | History enters inspectable memory layers; P1 retrieves related events when needed |
| Move from chat into coding or work | Character identity and shared capabilities continue while Code and Work keep mode-specific task state |
| Let an AI act locally | Files, terminal, web, browser, PPT, IDE, and CLI capabilities arrive through plugins |
| Control how the AI works | Presets, INJ entries, worldbooks, regex, recall routes, permissions, and plugins are configurable |
| Keep data and actions bounded | Local storage, workspace sandboxes, permission levels, approvals, and user isolation work together |

You may prefer another tool if you only need a lightweight memory SDK, a managed one-call API, a dedicated mature IDE assistant, or a minimal-memory chat client. Beilu is strongest when you need several capabilities to cooperate around one long-running AI.

## Choose an entry path

### A. Start with conversation

1. Follow [Installation](install.md).
2. Configure one AI service source.
3. Import or create a character.
4. Complete [Your First Chat](first-chat.md).
5. Open the memory trace under a reply and inspect what the turn actually used.

Best for long-term chat, roleplay, companionship, and evaluating memory first.

### B. Start with coding or work

1. Confirm your model works in Chat.
2. Switch to Code or Work.
3. Set the beilu-files workspace root.
4. Keep write approval enabled while opening only the permissions you need.
5. Connect YonBan IDE, CLI, web, browser, or PPT as required.

Best for reading projects, editing files, research, and deliverables.

### C. Build your own AI

1. Learn [Presets](../presets/overview.md) and [INJ Data Injection](../memory/inj-overview.md).
2. Compose [Plugins](../plugins/overview.md) by outcome.
3. Use worldbooks, MVU, regex, EJS, or AIRP for state and presentation.
4. Connect Python, Node, or standalone programs through the user plugin host.

## How the pieces combine

    User action
      ↓
    Mode / window route (Chat, Code, Work, Bot, companion...)
      ↓
    Shared capabilities (memory, prompts, APIs, tools, permissions, rendering)
      ↓
    Mode-specific storage and execution
      ↓
    Readback, display, or notification in the correct window

The important part is not the number of features. Memory must belong to the right character, tools must execute in the right workspace, results must return to the right window, and approvals must belong to the right user.

## What P1 and P2 actually do now

The old statement “P1 and P2 run automatically by default” is no longer correct.

### P1 is optional and routed per mode

- P1 has a plugin-level master switch.
- Each mode can choose self-driven P1, AI P1, or off.
- The two P1 routes are mutually exclusive and do not silently fall back to each other.
- Chat, Code, and Work currently declare self-driven P1 by default.
- Smart and Bot currently declare AI P1.
- User overrides take effect on the next turn.

Self-driven P1 does not call an LLM for each recall, but it keeps local services and lexical resources resident. See [Current P1 Runtime (Chinese evidence chapter)](../../../p1-recall/ch7-current-runtime.md).

### P2 is not a default automatic feature

The background P2 trigger has been stopped. The current button passes `manual:true` into `triggerP2Summary`, so the explicit manual path is no longer rejected by the `manual_button` guard. This confirms the call contract, not a fresh end-to-end acceptance of the external model call or final summary output.

Mechanical archiving and P2 AI summarization are separate chains. One working does not prove the other.

P3–P8 are not part of the new-user baseline. Verify each preset, trigger, and implementation before enabling it.

## Plugins are not all “automatically working”

The source tree contains 23 built-in plugin directories, while the new-user template lists 14 default plugins. Three states are different:

1. present in source;
2. loaded for this user or conversation;
3. the plugin's specific feature is enabled and configured.

For example, beilu-vectordb appears in the default plugin list while vector semantic search remains off until an embedding endpoint, model, and dimensions are configured. See the [Plugin Manual](../plugins/overview.md).

## Boundaries to understand

- The project changes quickly, so older documentation may trail the code.
- Local ownership means you manage API credentials, model downloads, disk data, and permissions.
- P1 has backend white-box evidence, but independent same-task quality benchmarks are not complete.
- Browser, IDE, Bot, multi-window, and asynchronous paths require their matching runtimes and real-environment verification.
- Multi-user server deployments use stricter safety defaults than local single-user installs.

## Next

- [Installation](install.md)
- [Your First Chat](first-chat.md)
- [UI Guide](ui-guide.md)
- [Memory System](../memory/overview.md)
- [Modes](../modes/overview.md)
- [Plugin Manual](../plugins/overview.md)
- [Security](../security/overview.md)
- [YonBan and Tool Execution](../yonban/overview.md)
