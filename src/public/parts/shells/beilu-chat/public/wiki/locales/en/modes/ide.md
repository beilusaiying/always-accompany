# Code Mode (Code / IDE)

## Entering Code Mode

| Method | Action |
|--------|--------|
| Top mode selector | Click the "Code" tab |
| Keyboard shortcut | `Ctrl+3` or `Alt+3` |

## Connecting Your Editor

1. Click the **connections** button in the activity bar to open the IDE connection panel
2. Install the YonBan extension (the panel has a guide button)
3. Click "Connect" to connect to VSCode or Cursor
4. On success, the status light turns green and shows the editor version and WebSocket address

Once connected, the AI can directly operate your editor. If disconnected, click "Reconnect."

## What Do You Want to Do

| Goal | Which Panel | Activity Bar Button |
|------|-------------|---------------------|
| Browse / edit project files | File Explorer | explorer |
| Chat with the AI | AI Chat | ai-chat |
| Adjust permissions / automation settings | Control Panel | control |
| Connect MCP services | MCP | mcp |
| Switch to a past conversation | Conversation History | conversations |
| Undo AI operations | Operation Timeline | timeline |
| Connect to VSCode / Cursor | IDE Connection | connections |
| Git operations | Git Management | git |
| Switch submodes | Submodes | submodes |

Click an activity bar button to switch to the corresponding sidebar panel. Click the same button again to collapse the sidebar.

## Control Panel

Click the control button in the activity bar to open it. Centrally manages runtime parameters for Code Mode:

| Control | Type | Description |
|---------|------|-------------|
| Permission level | Dropdown | L0 – L4, controls the range of operations the AI can perform |
| Clean mode | Dropdown | Select a code cleanup strategy |
| Manual clean | Button | Immediately perform a cleanup |
| Auto-save | Toggle | Automatically save file changes when enabled |
| Auto-continue | Toggle + delay setting | AI automatically proceeds to the next step after completing one; delay is configurable |
| Completion sound | Toggle | Play a notification sound when the AI finishes a task |

## File Explorer

Click the explorer button in the activity bar to open it.

- **Open Folder** — Select a local directory as the workspace
- **Open File** — Directly open a single file
- **Directory Tree** — Tree view of the project file structure; right-click menu provides new / rename / delete
- **Multi-tab Editor** — Opened files are arranged as tabs; press `Ctrl+S` to save
- **AI Approval Queue** — When the AI requests file modifications, they enter an approval queue where you can allow or reject each change

## Git Panel

Click the git button in the activity bar to open it.

- **Branch bar** — Current branch, ahead/behind counts, new / switch / merge / stash operations
- **Commit area** — Commit message input field + commit button
- **Changes list** — Staged / unstaged / untracked files; click to view a Diff preview
- **Commit history** — Browse past commits and their changes

## Operation Timeline

Click the timeline button in the activity bar to open it.

- Records all tool calls and code state snapshots made by the AI
- View the input parameters and return results of each operation
- Roll back to any historical point to prevent unintended changes from AI modifications

## Submodes (11)

Code Mode includes 11 built-in submodes covering the entire software development lifecycle:

| Submode | Purpose |
|---------|---------|
| Task Confirmer | Understand requirements, search for similar solutions online |
| Pre-Designer | Read specific code for design, down to exact lines |
| Framework Reviewer | Review soundness from the perspective of code architecture and overall flow |
| Deep Thinker | Algorithm design, framework logic, pathway logic, experimental validation |
| Code Expert | Focus on code implementation |
| Pre-Error Producer | Check for syntax errors, HTML tag errors, and review the process |
| Test Expert | Perform actual testing through script tools and browser DevTools |
| Debugger | Examine the big picture then focus on specifics for rapid diagnosis and fixes |
| Task Handover | Produce markdown documentation and confirm with the user |
| Large Project Coordinator | Scope locking, dependency ordering, multi-agent orchestration |
| Frontend Beautifier | Frontend design and visual polish |

Each submode can independently bind its own Preset, API source, model, and Sampling Parameters. Switching submodes automatically loads the corresponding configuration. See [Submodes & Switching](beilu:wiki/modes/submodes.md) for details.

## Interface Layout

Code Mode uses an IDE-style layout:

- **Activity bar** (far left): Icon buttons for switching sidebar panels
- **Sidebar**: Panel content corresponding to the selected activity bar button
- **Main area**: AI conversation area + code / Diff viewer

Layout differences compared to Chat Mode:

| Chat Mode | Code Mode |
|-----------|-----------|
| Symmetric three-column layout | IDE-style asymmetric layout |
| Left/right panels collapsible | Persistent activity bar + switchable sidebar |
| Conversation-centric | File- and tool-operation-centric |

## Additional Notes

- When entering Code Mode, the INJ-2 Injection rule is automatically enabled (coding-specific context) — no manual configuration needed
- Code Mode corresponds to backend mode value `code`, frontend Tab `files`
