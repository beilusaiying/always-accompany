# Security Center

Go to [Settings → Security Center](beilu:settings/security) to view security status and manage security policies.

## Quick Actions

1. Open the [Security Center](beilu:settings/security) panel
2. View the **Security Summary** at the top of the panel to understand the current security status
3. Click **One-Click Security Check** to scan all check items and summarize the results
4. Review and adjust security policies item by item in the check item list

### Panel Controls Overview

| Control | Description |
|---------|-------------|
| Security Summary | Displays a security status overview at the top of the panel |
| One-Click Security Check | Button; scans all check items and summarizes results |
| Check item list | Dynamically renders different controls based on check item type (dropdown / toggle / EJS configuration / list) for viewing and adjusting security policies item by item |
| Content filtering — Blacklist keywords | Text input; configure keywords to filter |
| Content filtering — Username filtering | Text input; configure usernames to filter |
| iframe security level | 3-tier selection; controls the restriction level for iframe embedding |

Each item in the check item list corresponds to a specific security policy (such as deployment mode, command execution, sandbox configuration, etc.). The owner can manage them centrally here without entering individual plugin configurations.

## Switching Deployment Mode

always-accompany distinguishes between two deployment modes, with security policies adjusted accordingly:

### local mode (Default)

Suitable for personal local use. Security policies are relatively relaxed:

- File operations default to being allowed within the workspace
- Command execution is allowed by default
- Symlinks do not undergo real-path validation
- The sole user is the owner

### server mode

Suitable for multi-user shared deployment. Security policies are tightened:

- Command execution is off by default; requires explicit enabling by the owner
- Symlinks undergo real-path validation (prevents symlink escape)
- Writing security-sensitive configuration requires owner Permission
- Invalid deployment mode values fall back to server (fail-safe)

Switch via the environment variable `BEILU_DEPLOY_MODE=server` or the `config.deployMode` setting in the Security Center panel.

## Managing Plugin Security Configuration

Modifying the following plugin configurations requires owner Permission (configured in the [Plugin Management](beilu:settings/plugins) panel):

| Plugin | Sensitive Configuration | Risk |
|--------|------------------------|------|
| beilu-files | allowExec / rootPath / workspaceRoot | Enable command execution / change sandbox boundary |
| beilu-ejs | sandboxOptOut | Disable EJS sandbox |
| beilu-regex | regexGuard | Disable ReDoS protection |

Write operations to these configurations are uniformly intercepted at the parts_router's config/setdata entry point (`partConfigWriteNeedsOwner`), rather than intercepted individually within each plugin.

## Three Core Principles

1. **Secure by Default**: All security toggles default to the most secure state; high-risk features must be explicitly enabled
2. **Owner-Controlled**: Security policies are controlled by the instance owner; regular users cannot modify security-sensitive configurations
3. **Defense in Depth**: Each security domain (path/network/execution/authentication) has multiple layers of protection; a single layer being bypassed does not lead to total compromise

## Security Architecture Overview

| Security Domain | Core Mechanism | Protected Target |
|-----------------|---------------|-----------------|
| Authentication | JWT + API Key + Brute-force defense | User identity |
| Path fencing | confinePath + confineSegment | File system |
| Conversation ownership | router.param("chatid") central validation | Conversation data |
| Content security | CSP + WS Origin validation | Frontend security |
| Execution gating | deployGatedAllow | Command execution |
| Plugin security | partConfigWriteNeedsOwner | Plugin configuration |
| Token gate | pet-token authentication | Screenshot Injection |

## File Operation Security

Four-layer defense in depth for beilu-files:

1. **Path normalization**: Neutralizes `..` and absolute path injection, anchoring paths to the workspace
2. **System path blocking**: Prevents access to system-sensitive directories and files
3. **Workspace sandbox**: All operations must be within workspaceRoot
4. **Whitelist/Blacklist**: Fine-grained path control

See [File Operations (beilu-files)](../plugins/files.md) for details. Configure in the [Plugin Management](beilu:settings/plugins) panel.

## Conversation Data Protection

### Ownership Validation

All endpoints with `:chatid` as a path parameter go through `router.param("chatid")` central ownership validation — verifying whether the requesting user is the owner of that conversation. Requests that fail validation receive a 403.

### chatid in Body

Some endpoints pass chatid through the request body (e.g., manual-tool-call, group bind, branch); these endpoints have independent inline validation logic.

## Network Security

- **CSP (Content Security Policy)**: Implemented; restricts the sources from which resources can be loaded
- **WS Origin validation**: Validates the Origin header during WebSocket connections to prevent cross-site WebSocket hijacking
- **safeFetch**: Outgoing requests go through a safe fetch function with built-in timeouts and malicious URL filtering

## Multi-User Isolation

In server mode, always-accompany performs user-level isolation for the following data:

- Conversation data and chat history
- Preset configurations and Preset files
- Plugin configurations (per-user isolation via AsyncLocalStorage)
- File operation workspace configurations
- Memory system data

## Navigation

- [Authentication and Permissions](auth.md) — JWT / API Key / Permission level details
- [File Operations (beilu-files)](../plugins/files.md) — File security mechanisms
- [Plugin Overview](../plugins/overview.md) — Plugin security configuration
