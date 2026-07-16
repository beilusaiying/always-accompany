# YonBan

Install YonBan from the extension marketplace and the AI can directly operate your IDE — read/write files, execute commands, Git operations, and more. All 30+ tools are governed by the Approval system.

## Installation

Search for **always-accompany** in the VSCode or Cursor extension marketplace and install the YonBan extension.

## Connecting to always-accompany

| Step | Action |
|------|--------|
| 1 | After installing the extension, YonBan automatically connects to the always-accompany backend (default port 8931) |
| 2 | The extension automatically generates an auth Token, writes it to `~/.beilu/ide_ws_token`, and the backend reads it to complete the WebSocket handshake |
| 3 | Once connected, enter [Code Mode](beilu:mode/files) in the frontend to use all IDE tools |

Automatic reconnection on disconnect is supported.

## Frontend Connection Panel

Click the connections button in the Code Mode activity bar to open the connection panel.

**Connection cards**: The panel displays two cards for VSCode and Cursor, each containing:

- Status light (green = connected / gray = disconnected)
- Editor version number
- WebSocket address
- Current session duration

**Action buttons**:

- Reconnect — manually reconnect after a disconnection
- Disconnect — actively disconnect the current connection
- Connect — connect to a new editor instance
- Guide — view the extension installation and configuration tutorial

**Connection settings**:

| Setting | Description |
|---------|-------------|
| Auto-reconnect | Toggle; automatically attempt to reconnect after disconnection |
| Port | Configure the WebSocket port (default 8931) |
| Timeout | Connection timeout threshold |

**Manual tool call**: At the bottom of the panel, you can manually send tool calls to the editor for debugging or testing — select the target IDE, select a tool, fill in the parameter JSON, send, and view the result.

## Navigation

- [Tool List](tools.md) — 30+ tools organized by category
- [Approval and Permissions](approval.md) — Permission levels and Approval workflow
- [Execution Pipeline](architecture.md) — Complete data flow from AI output to IDE execution
- [Code Mode](beilu:wiki/modes/ide.md) ([enter](beilu:mode/files)) — Full IDE mode interface guide
