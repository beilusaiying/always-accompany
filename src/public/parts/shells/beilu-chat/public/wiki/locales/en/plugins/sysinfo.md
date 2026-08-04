# System Information: Let the Model Know Its Environment Only When You Choose

beilu-sysinfo collects current time, timezone, and runtime details. It can optionally include OS, hostname, username, process memory, and custom fields.

This is useful for time-sensitive work, platform-specific commands, and environment-aware guidance. Ordinary character chat usually does not need it.

## Do not confuse the two switches

- The plugin-level `enabled` setting defaults to on, meaning the capability is available.
- The `INJ-plugin-sysinfo` entry that actually places data into prompts currently defaults to off.
- The plugin's own GetPrompt currently returns no injection.

Loaded therefore does not mean system details are sent every turn. Enable the INJ entry only when needed and inspect its preview.

## Available fields

| Field | Default | Notes |
|---|---|---|
| Local date, time, timezone | On | Scheduling and time-sensitive tasks |
| OS and architecture | On | Command and path differences |
| Hostname and username | With OS information | Potentially private |
| Process memory | Off | Beilu process memory, not a whole-system dashboard |
| Custom fields | Empty | User-defined fixed environment notes |
| Refresh interval | Every generation | Can cache for a chosen number of seconds |

## End-to-end path

```text
runtime environment
  → sysinfo collects and formats selected fields
  → settings preview
  → INJ-plugin-sysinfo decides whether the current mode receives them
  → selected AI service
```

Configuration is stored in one global project-data file rather than per user. Once injection is enabled, selected fields become part of the final prompt and reach the active AI service.

On a shared server, keep only necessary time/OS data and remove hostnames, usernames, memory details, and sensitive custom fields.

See [INJ](../memory/inj-overview.md), [Security](../security/overview.md), and [Plugin Combinations](combinations.md).
