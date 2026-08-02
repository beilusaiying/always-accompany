# File Operations (beilu-files)

beilu-files enables the AI to read and write files and execute commands on your computer. It is the core tool plugin for [IDE Mode](beilu:mode/files) and [Work Mode](beilu:mode/work) -- AI uses it to browse directories, read code, write files, and execute terminal commands.

All file operations are executed within a sandbox, protected by multiple layers of security mechanisms.

## Supported Operations

| Operation Type | Description | AI Tag |
|---------------|-------------|--------|
| read | Read file contents | `<file_op>` / `<tool_call>` |
| write | Write/overwrite a file | `<file_op>` / `<tool_call>` |
| create | Create a new file | `<file_op>` / `<tool_call>` |
| delete | Delete a file | `<file_op>` / `<tool_call>` |
| list | List directory contents | `<file_op>` / `<tool_call>` |
| move | Move/rename a file | `<file_op>` / `<tool_call>` |
| exec | Execute a terminal command | `<file_op>` / `<tool_call>` |

## Security Architecture

beilu-files employs a four-layer defense-in-depth approach; every file operation (regardless of source) must pass through:

### Layer 1: Path Canonicalization (resolveCanonicalOpPath)

Anchors relative paths to the workspace root directory, resolves `..` (parent directory references), and prevents sandbox escape via path concatenation.

### Layer 2: System Path Blocking (checkSystemDriveBlock)

Blocks access to system-sensitive paths, sensitive file extensions, and sensitive keywords.

### Layer 3: Workspace Sandbox

All operations must execute within the workspace root directory (workspaceRoot). Paths outside the workspace boundary are rejected outright.

### Layer 4: Allowlist / Blocklist

Fine-grained path allow/deny lists. Uses prefix + boundary delimiter comparison (prevents `/a/b` from accidentally blocking `/a/bc`).

### Three Shared Paths

Regardless of where an operation originates, it must pass through the same security gate:

- **AI path**: `<file_op>` / `<tool_call>` tags in AI replies
- **Frontend path**: User directly operating files through the UI
- **Approval path**: User approving a pending operation

## Operation Flow

### AI-Initiated Operations

```
AI reply contains file operation tags
    ↓
ReplyHandler parses the operation
    ↓
Bot permission gate (N42, checks access tier for Bot-sourced requests)
    ↓
always rule check (N46)
    ↓
Permission switch check
    ↓
validateOpSecurity (four-layer defense-in-depth security validation)
    ↓
Auto-approve / enter pending approval queue
    ↓
executeFileOperation (disk operation)
    ↓
Result enters the pendingOpResults queue
    ↓
Next turn's GetPrompt injects the result; AI sees the execution result and continues working
```

### Approval Mechanism

Certain operations (such as write, delete, execute command) require user approval by default:

- **Auto-approve**: Read operations typically pass automatically
- **Pending approval queue**: Write/delete/execute operations enter the queue and await user confirmation in the frontend
- **Batch approval**: All pending operations can be approved in one click

## Command Execution (exec)

The exec operation type allows AI to execute terminal commands. Due to the higher security risk, it is subject to additional gate controls:

- **deployGatedAllow gate**: Local deployment (local mode) allows by default; server deployment (server mode) is disabled by default and requires the instance owner to explicitly enable it in the Security Center
- The `allowExec` switch can be controlled via the configuration panel
- Can be forcibly enabled via the environment variable `BEILU_FILE_EXEC=on`

## File History

beilu-files records file operation history and supports rolling back to previous versions. The old version is automatically saved before write operations, enabling recovery if issues arise.

## GitHub Integration

beilu-files includes a GitHub integration module that supports repository operations via the GitHub API.

## Workspace Settings

### workspaceRoot

The workspace root directory is the sandbox boundary for beilu-files. All file operations must stay within this directory. It can be set in the plugin configuration.

### workspaceRoots

Multi-workspace support. Multiple workspace root directories can be configured, allowing the AI to switch between them.

## Multi-User Isolation

In multi-user scenarios, beilu-files uses AsyncLocalStorage for per-user isolation. Workspace configuration and other fields are stored independently per user, ensuring users do not interfere with each other.

## Navigation

- [Plugin Overview](overview.md) -- Plugin system introduction
- [Security Center](../security/overview.md) ([Open Panel](beilu:settings/security)) -- Security policy overview
- [Permissions & Authentication](../security/auth.md) -- Permission tiers
