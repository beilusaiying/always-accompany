# Live Input: Filter First, Then Reuse the Main Chat Pipeline

beilu-live turns a live chat into another input source for the existing conversation system. Presets, memory, mode selection, AI service configuration, and streaming output remain on the normal main path.

## When it is worth using

- You need to select answerable messages from a busy live room.
- Character settings and long-term memory should still apply on stream.
- You do not want one model call per incoming message.
- Filtering, reply pacing, and conversation ownership must remain separate controls.

For one or two occasional questions, manual copy and paste is simpler. This plugin is not an OBS replacement, a streaming stack, or a complete moderation service.

## Current defaults

- The plugin master switch is off by default; loading it does not connect to a room.
- “Enabled” and “running” are different states: enable the capability, then start a session.
- The current platform registry includes Bilibili.
- The optional assistant is off by default; the main route does not require a second generation chain.

## End-to-end path

```text
continuous platform messages
  → platform adapter normalizes events
  → deterministic filter: length / blacklist / keywords / cooldown / dedup
  → candidate pool with capacity and TTL
  → selector: recent users / last replied user / gift weight
  → one batch at the configured minimum interval
  → Live mode enters the existing main chat pipeline
  → preset + memory + selected AI service produce the reply
```

Filtering does not call a model. An empty pool can skip a round, and high message volume does not become one request per message.

## Which conversation owns the output?

The carrier priority is:

1. an explicit chat ID in live configuration;
2. the currently running game-companion session;
3. otherwise startup reports that no carrier exists instead of guessing the current browser window.

This keeps replies, history, and memory attached to an explicit conversation owner.

## What you can configure

Open “Live” in [Plugin Management](beilu:settings/plugins). Per-user settings cover:

- platform, room ID, and credentials;
- blacklist, keyword mode, and message length;
- per-user cooldown and text deduplication window;
- pool capacity and expiry;
- selection count, gift weighting, and last-replied marking;
- generation interval and empty-pool skipping;
- heartbeat, reconnect, backoff, and HTTP timeouts;
- optional assistant frequency and service source.

Saving configuration does not start a connection. Start, stop, and status are separate runtime actions.

## Data and credential boundaries

- Each user has a separate live configuration in their user data directory.
- A platform connection sends the room ID and necessary credentials to that platform.
- Selected messages become part of the final prompt and therefore reach the AI service you selected.
- Public Bilibili chat can be attempted without login cookies; identity-dependent access requires the relevant credentials.
- Keep credentials in the plugin panel, not in presets, worldbooks, or shared logs.

Works well with [Memory](../memory/overview.md), [Game Companion](../modes/game.md), presets/worldbooks, eye, and AIRP. See [Plugin Combinations](combinations.md).
