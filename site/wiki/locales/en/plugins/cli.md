# CLI Tool Backend: Local Tools Without Requiring an IDE

beilu-cli is a tool execution backend shipped with the main application. It is for users who want file, search, command, and document tools from Beilu without treating an IDE as a required entry point.

It is not another chat interface and does not replace Code or Work mode. Modes interpret the task and assemble prompts and memory; CLI executes allowed tools.

## What it changes

| Previous limitation | With CLI |
|---|---|
| Local tools exist only while an IDE extension is open | The main app can start its own tool backend |
| Backend state is inferred from a terminal | The panel reports health, actual port, workspace, and recent logs |
| A crashed process must be reopened manually | Automatic restart is available, with a crash-loop circuit breaker |
| CLI and YonBan duplicate resource use | They may coexist or use an automatic handoff policy |

If you always work in YonBan and never need tools outside the IDE, disable CLI auto-start.

## Defaults and lifecycle

- Preferred port: 8931. If the bound port changes, the runtime registry is authoritative.
- Auto-start and auto-restart are on by default.
- Coexistence with YonBan is allowed by default.
- A manual stop is not undone by auto-restart.
- A manual start or restart is an explicit user override of automatic handoff.
- Plugin unload and application shutdown use the same child-process stop chain.

## End-to-end path

```text
Code / Work produces a tool call
  → the IDE connection layer selects an available backend
  → WebSocket connects to CLI server
  → token and port registry provide discovery
  → the tool executes under beilu-files workspace and safety settings
  → structured output returns to the original task and chat ID
```

Configuration lives in the project data directory. Runtime port/token discovery and checkpoints live under user/workspace `.beilu` directories, not inside plugin source.

## Controls

The CLI connection/settings area can start, stop, restart, change the preferred port, control auto-start/restart, choose YonBan coexistence, inspect lifecycle state, and view recent backend logs. Port changes require a restart.

## Workspace and safety

CLI reuses beilu-files settings instead of creating a second file-permission system. Check the workspace root, command permission, write/delete approval, registry token, and conversation ownership.

Do not widen the workspace root just to access one file; that widens every file tool at once.

See [Plugin Combinations](combinations.md), [Files](files.md), [YonBan](../yonban/overview.md), and [Approvals](../yonban/approval.md).
