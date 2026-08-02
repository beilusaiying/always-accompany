# Work Mode (Work)

## Entering Work Mode

| Method | Action |
|--------|--------|
| Top mode selector | Click the "Work" tab |
| Keyboard shortcut | `Ctrl+4` or `Alt+4` |

When you switch to Work Mode, the system automatically starts the scheduler (scheduled task dispatcher). The default view is a full-width AI conversation area.

## Task-Based Operations

### Managing Tasks

Click the **overview** button in the activity bar to open the task board.

- **Task list** — Tasks are grouped by status: In Progress / To Do / Completed, each group showing a count and progress bar
- **Work file management** — Create, view, edit, and delete work files (CRUD); files are linked to tasks

### Adjusting AI Permissions

Click the **toolkit** button in the activity bar to open the toolbox.

- **Permission quick presets** — One-click switch: Full (all permissions) / Minimal (basic permissions) / Read-only
- **Per-item permission toggles** — Set permissions individually for 11 tool capabilities
- **Path allowlist / blocklist** — Specify file paths the AI can or cannot access
- **Command category authorization** — Batch-authorize or block commands by category

### Delegating Tasks to the AI

- Delegate tasks for the AI to complete independently; the AI works in a separate thread without blocking the main conversation
- Monitor delegation progress and results

### Setting Up Scheduled Tasks

- Configure scheduled triggers (cron-style scheduling)
- Automatically execute predefined workflows
- The scheduler starts automatically when entering Work Mode

### Orchestrating Pipelines

- **Skill Group cards** — Each card shows the group name and step count; click the start button (play) to begin execution
- **New Group** — Click the new button to open a modal where you enter a group name and select which submodes to include and their order; execution automatically progresses through submodes in sequence

### Connecting MCP Services

Click the **mcp** button in the activity bar.

- Connect MCP (Model Context Protocol) services to extend the AI's available tool set
- Supports custom MCP server configuration

### Monitoring Runtime Status

Click the **operations** button in the activity bar to open the monitoring panel and view runtime status and logs.

### Managing Parallel Tasks

Click the **groups** button in the activity bar to manage parallel task groups.

## Activity Bar Buttons

| Button | Name | Sidebar Panel |
|--------|------|---------------|
| chat | Default Chat | Full-width AI conversation (default view) |
| overview | Task Board | Task list, work file management |
| history | Conversation History | Past conversation list and switching |
| toolkit | Toolbox | Permissions, tools, command authorization |
| mcp | MCP | MCP service connection and management |
| operations | Monitor | Runtime status and log monitoring |
| groups | Parallel Groups | Parallel task group management |
| submodes | Submodes | Submode list (dynamically injected) |

## Submodes (11)

Work Mode includes 11 built-in submodes covering the full workflow lifecycle:

| Submode | Purpose |
|---------|---------|
| Task Confirmer | Understand requirements, verify understanding, create task files |
| Task Designer | Read the task MD, reverse-engineer the design and execution flow |
| Process Optimizer | Optimize processes, reduce token usage, streamline steps |
| Framework Reviewer | Review process designs for errors; only optimize, never reject |
| Prompt Designer | Design Prompts needed for tasks |
| Prompt + Preset Designer | Design always-accompany Prompts and Presets themselves |
| Skill / Script Maker | Create scripts, skills, and MCP integrations |
| Process Assembler | Assemble Prompts, skills, and scripts into flow groups |
| Flow Group Executor | Run flow groups, execute steps in order, and log results |
| Verifier | User verification or automated verification of execution results |
| Wrap-up & Archive | Archive task MDs, update indexes, generate completion reports |

Each submode can independently bind its own Preset, API source, model, and Sampling Parameters. See [Submodes & Switching](beilu:wiki/modes/submodes.md) for details.

The submode selector bar is located above the input box. Click it to open a floating list for switching. In the submode management panel, you can configure the ID, icon, name, description, Preset binding, API source selection, Post-processing rules, prefill content, and enable/disable toggle.

## Backend Mode Value

Work Mode corresponds to backend mode value `work`, frontend Tab `work`.
