# Approval and Permissions

All write operations in YonBan are governed by the Approval system. The Permission level determines what the AI can do, and the Approval workflow determines how operations are approved.

## Permission Levels

| Level | Name | Allowed Operations |
|-------|------|--------------------|
| L0 | Read-only | Only read operations such as read_file, list_files, search |
| L1 | Read | Read operations + diagnostics + navigation |
| L2 | Read/write with Approval | Read + write operations (each write operation requires per-item user Approval) |
| L3 | Full + commands | Read/write + command execution (run_command / run_script) |
| L4 | Trusted | All operations auto-approved, Approval bypassed |

Switch levels in the Permission level dropdown in the Code Mode control panel. Visit the [Security Center](beilu:settings/security) to view global security policies.

## Approval Workflow

The flow of a write operation from AI issuance to actual execution:

1. AI issues a write operation request (write_file / run_command / git_commit, etc.)
2. Request enters the Approval queue
3. Frontend connection card pops up an Approval prompt
4. User selects **Approve** or **Reject**
5. Approved → execute the operation and return results; Rejected → return the rejection reason, and the AI adjusts its strategy accordingly

In L4 Trusted mode, steps 2-4 are automatically skipped.

## Five-Level Security Gate

The Approval system internally chains five security gates; interception at any level blocks execution:

| Level | Name | Function |
|-------|------|----------|
| 1 | Command Gate | Blacklisted commands are permanently prohibited (e.g., rm -rf /); graylisted commands require Approval (each can be configured for whether L4 also requires confirmation); capability-whitelisted commands are allowed based on Permission level |
| 2 | Rule Set Engine | User-defined rules: deny (reject) / ask (require Approval) / allow (pass), matched by priority |
| 3 | Approval Gate | System-enforced Approval (L2 write operations) / policy Approval (rule set matches ask) / trusted bypass (L4) |
| 4 | Unified Execution Gate | Fail-closed design — defaults to rejection when the gate encounters an error, preventing accidental passthrough |
| 5 | Approval Fingerprint Binding | After Approval, a sha256 fingerprint is generated for the request; the fingerprint is verified at execution time — preventing request tampering after Approval |

## Command Security

Command execution (run_command / run_script) has an additional security layer:

| List | Description |
|------|-------------|
| Blacklist | Severely destructive commands are permanently prohibited regardless of Permission level (e.g., disk formatting, recursive deletion, disk wiping/boot modification). Each entry can be individually enabled/disabled/deleted; entries can be added/removed from the Permission panel |
| Graylist | Commands requiring explicit Approval. Each entry has an "Ask at L4 too" toggle: checked = Approval prompt even at L4 full trust (e.g., shutdown, reg); unchecked = capped at L3, L4 bypasses Approval (e.g., git rebase, npm uninstall) |
| Capability Whitelist | Common safe commands (e.g., ls, cat, git status), auto-approved at L3+ |

## Frontend Control Panel

Click the control button in the Code Mode activity bar to open the control panel, which centrally manages the following settings:

| Control | Type | Description |
|---------|------|-------------|
| Permission level | Dropdown | L0 – L4, controls the range of operations the AI can execute |
| Auto-save | Toggle | When enabled, file modifications are automatically saved to disk |
| Auto-continue | Toggle + delay setting | AI automatically continues to the next step after completing one; configurable wait delay |
| Completion sound | Toggle | Play a notification sound when the AI completes a task |
| Clean mode | Dropdown | Select the code cleanup strategy |
| Manual cleanup | Button | Execute a cleanup immediately |

## Navigation

- [YonBan Overview](overview.md) — Installation and connection
- [Tool List](tools.md) — Which tools are read vs write
- [Execution Pipeline](architecture.md) — Where Approval sits in the pipeline
- [Security Center](beilu:wiki/security/overview.md) ([open panel](beilu:settings/security)) — Global security architecture
