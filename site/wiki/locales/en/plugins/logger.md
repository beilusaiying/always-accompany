# Logger: Keep Recent Errors and Warnings for Diagnosis

beilu-logger is a troubleshooting aid, not a long-term audit store. It captures recent server-side `console.error` and `console.warn` entries so a settings or diagnostic view can show what actually failed.

## Current behavior

- Starts capturing error/warn on load.
- Preserves original terminal output.
- Keeps a 500-entry in-memory ring buffer.
- Queries return up to 200 entries by default and can filter by time or level.
- The buffer can be cleared from configuration or the API.
- Unload stops writes to its own buffer without dismantling other logging hooks.

## Data path

```text
plugin or service emits warning/error
  → logger copies it without blocking original output
  → in-memory ring buffer
  → settings/API filters by time or severity
  → user identifies the first causal error
```

It is not persistent storage, does not capture every ordinary log, and does not prove a feature passed a test. Restarting the process clears the in-memory history.

## Before sharing logs

Stacks may contain local paths, request information, configuration fragments, or external-service errors. Remove usernames, absolute paths, API keys, cookies, tokens, private conversation, and identifiable workspace or live-room data before posting an Issue.

Recommended order: reproduce once, note the time, inspect the first error and adjacent warnings, separate the root error from its follow-on failures, then clear and reproduce to confirm it is repeatable.

See [Security](../security/overview.md) and [Plugin Development](../developer/plugin-dev.md).
