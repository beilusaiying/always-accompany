# AI Operation Backends

The AI operates your development environment through a backend connection — read/write files, execute commands, Git operations, and more. All 42 tools are governed by the Approval system.

Three backends are supported:

| Backend | Use case | Installation |
|---------|----------|--------------|
| **CLI** | No IDE needed, auto-starts with the app | None — built-in, works out of the box |
| **VSCode** | Developing in VSCode | Search always-accompany in the marketplace |
| **Cursor** | Developing in Cursor | Search always-accompany in the marketplace |

All three backends share the same protocol (WebSocket + `<ideToolCall>` tags) and the same tool set — the AI doesn't need to distinguish between them. Backends only execute tools: all security decisions (trust level, permission rules, command black/gray lists, approval) happen in the app itself, so your settings in the AI Control Panel apply equally to all three backends.

## CLI Backend (no IDE, zero install)

The CLI backend starts automatically with the app — no manual steps required:

- **Workspace**: follows the file panel's "Open Folder" — whichever directory you open in the file tree is where the CLI works (changing it hot-switches automatically, no restart needed)
- **Port / auto-start**: configured in the CLI Backend section of the Backend Management panel (default port 8931, auto-increments if occupied)
- **Restart / stop**: one-click in the same panel
- AI questions (`question`) should be answered in the beilu web UI — the CLI backend itself has no interactive interface

## IDE Backends (VSCode / Cursor)

Search for **always-accompany** in the extension marketplace; it connects automatically after installation.

## Connecting to always-accompany

| Step | Action |
|------|--------|
| 1 | After the backend starts (CLI auto-starts with the app / IDE extension auto-starts), it writes its actual port and auth token to discovery files under `~/.beilu/` |
| 2 | The app automatically discovers the active backend via those files and completes the WebSocket handshake (works even after port auto-increment) |
| 3 | Once connected, enter [Code Mode](beilu:mode/files) in the frontend to use all tools |

Automatic reconnection on disconnect is supported. Even with no backend connected, the AI can still read/write files inside the workspace through the app's built-in `<file_op>` tools — the two tracks run in parallel, and a backend is simply the more capable one.

## Frontend Connection Panel

Click the connections button in the Code Mode activity bar to open the Backend Management panel.

**Connection cards**: The panel displays three cards for CLI, VSCode and Cursor, each containing:

- Status light (green = connected / gray = disconnected)
- Backend version number
- WebSocket address
- Current session duration

**Action buttons**:

- Reconnect — manually reconnect after a disconnection
- Disconnect — actively disconnect the current connection
- Connect — connect to a backend instance
- Guide — view the installation and configuration tutorial

**Connection settings**:

| Setting | Description |
|---------|-------------|
| Auto-reconnect | Toggle; automatically attempt to reconnect after disconnection |
| Port | Configure the WebSocket port (default 8931) |
| Timeout | Connection timeout threshold |

**Manual tool call**: At the bottom of the panel, you can manually send tool calls for debugging or testing — select the target backend, select a tool, fill in the parameter JSON, send, and view the result.

## Navigation

- [Tool List](tools.md) — tools organized by category
- [Approval and Permissions](approval.md) — Permission levels and Approval workflow
- [Execution Pipeline](architecture.md) — the complete data flow from AI output to execution
- [Code Mode](beilu:wiki/modes/ide.md) ([enter](beilu:mode/files)) — full Code Mode interface guide