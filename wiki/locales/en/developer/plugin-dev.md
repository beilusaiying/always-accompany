# Plugin Development and Integration

always-accompany's plugin system allows you to write custom plugins to extend functionality. Plugins participate in the [message pipeline](message-pipeline.md) through standardized interfaces, and can inject prompts for the AI, process AI replies, register their own HTTP endpoints, and provide configuration panels.

This page has two parts: **how to build a plugin** (structure, lifecycle, interfaces) and **how to connect it** (integrating with the conversation pipeline, the frontend, and external applications).

## Part 1: How to Build a Plugin

### Directory Structure

The minimal directory structure of a plugin:

```
plugins/my-plugin/
├── beilu-part.json    ← Part manifest (required — the discovery mechanism only recognizes this)
├── info.json          ← Localized display information (required)
└── main.mjs           ← Plugin entry point (required)
```

### beilu-part.json (Part Manifest)

The part tree discovery mechanism **only scans `beilu-part.json`**. If a directory contains `main.mjs` but no manifest, the plugin will not be included in the part enumeration and the backend will emit an `orphan_part_no_manifest` warning.

```json
{
  "type": "plugins",
  "dirname": "my-plugin"
}
```

- `type`: Part type path (always `plugins` for plugins)
- `dirname`: Directory name — must match the actual directory name

### info.json (Display Information)

Localized information organized by language key, displayed in the plugin list and detail pages:

```json
{
  "zh-CN": {
    "name": "我的插件",
    "avatar": "https://api.iconify.design/mdi/puzzle.svg",
    "description": "一句话描述",
    "description_markdown": "**详细描述**，支持 Markdown。",
    "version": "0.1.0",
    "author": "你的名字",
    "tags": ["标签"]
  },
  "en-UK": { "name": "My Plugin", "description": "..." }
}
```

### main.mjs (Entry Point)

Export an object containing lifecycle hooks and interfaces:

```javascript
export default {
  info,                // typically imported from info.json
  Init,                // optional: install-time initialization (once per user)
  Load,                // optional: loaded each time at runtime
  Unload,              // optional: unload (in-process removal)
  Uninstall,           // optional: cleanup when the plugin is deleted
  interfaces: {
    chat: {
      GetPrompt,       // inject prompts
      TweakPrompt,     // adjust the assembled prompt_struct
      ReplyHandler,    // process AI replies (can trigger regeneration)
    },
    config: {
      GetData,         // read configuration/state
      SetData,         // write configuration/trigger actions
    },
  },
};
```

### Lifecycle and Ordering

Driven by `server/parts_loader.mjs`; the order is fixed:

```
Init({ router, username })   ← install-once per user (gated by parts_init record)
  ↓
Load({ router, username })   ← first load at each runtime
  ↓
interfaces.config.SetData(saved config)   ← framework re-injects parts_config persisted configuration
```

Key points:

- **SetData runs after Load** — `Load` cannot access framework-injected persisted configuration; initialization that depends on configuration must go in SetData or be deferred (lazy execution).
- `Init` only executes once after installation (guarded by the on-disk `parts_init` record); within a worker isolate it executes once per isolate (in-memory gate).
- At startup the framework first **shallow-loads** (only `import` to warm the module cache, no hooks run), then **full-preloads** in the background (complete lifecycle); lazy loading on the user request path serves as a fallback.
- Built-in plugins placed in the `plugins/` directory are automatically registered as default plugins (`plugins/main.mjs` container scans all subdirectories containing `main.mjs` during Load); plugins that fail to load are not registered (prevents dirty entry resurrection).
- **Hot reload = restart the process** (Deno does not support single-file ESM unloading); code changes require a service restart to take effect.
- The plugin reference you receive is a lazy proxy (FullProxy); after a reload, old references automatically point to the new instance.

## Part 2: How to Connect — Integrating with the Conversation Pipeline

Each conversation turn, the pipeline touches a plugin's `interfaces.chat` three hooks in a fixed order. To participate, place the plugin in `plugins/` (it participates automatically after registration) — no additional configuration is needed.

### GetPrompt — Pre-reply Injection

All plugins' GetPrompt calls are **issued concurrently and awaited together**; the return value goes into `prompt_struct.plugin_prompts[plugin name]`.

**Signature**: `GetPrompt(args)` (args = chatReplyRequest, contains `chatid` / `username` / `chat_log`, etc.)

**Return value**:

```javascript
{
  text: [
    { content: "Prompt text", important: 0 }   // sorted by important, enters the "plugins" segment
  ],
  additional_chat_log: [],   // optional: entries to append to the chat log segment
  extension: {},             // optional: data passed between plugins (not sent directly to the AI)
}
```

### TweakPrompt — Post-assembly Adjustment

Executes in `detail_level` rounds after all GetPrompt calls complete (default 3 rounds: dl = 2 → 1 → 0); plugins within each round run concurrently.

**Signature**: `TweakPrompt(args, prompt_struct, my_prompt, detail_level)`

- `prompt_struct`: The complete prompt structure (can be modified directly)
- `my_prompt`: This plugin's return value from the GetPrompt phase
- Return value: none (modify `prompt_struct` directly)

Typical per-round usage: dl=2 reads other plugins' extensions → dl=1 reorganizes message sequences → dl=0 final adjustments.

### ReplyHandler — Post-reply Processing

After the AI reply arrives, called **serially per plugin** within the regeneration loop.

**Signature**: `ReplyHandler(result, { ...args, prompt_struct, AddLongTimeLog })`

- `result`: The reply object; modifying `result.content` modifies the reply content (`content_for_show` is the display-layer text)
- `AddLongTimeLog(entry)`: Attaches tool-call traces to this message for persistence (visible across turns)
- **Return value: truthy = trigger regeneration** (the regen loop has no iteration limit; your logic controls termination); falsy = pass through
- An exception thrown by a single plugin is isolated and skipped; it does not interrupt other plugins' ReplyHandler calls

Typical usage: parse custom tags in the AI reply → execute operations (file read/write, variable setting) → inject results into the next round via GetPrompt.

### Inter-plugin Communication

Plugins do not import each other directly; they communicate indirectly through the `extension` field of `prompt_struct`:

1. Plugin A writes `extension.my_data` in its GetPrompt return value
2. Plugin B reads `prompt_struct.plugin_prompts['plugin-a'].extension.my_data` during the TweakPrompt phase

### Mode Pipeline (Advanced)

Generation goes through the ModeDef pipeline (one pipeline per mode: chat/code/work, etc.). Plugins that have been migrated into the pipeline menu are dispatched by mode via dispatch; plugins outside the menu are called directly — **new plugins are called directly by default and participate in all modes** without needing to register in the pipeline menu.

## Part 3: How to Connect — Frontend Integration

### Self-registering HTTP Endpoints

The `router` received in `Init` / `Load` is a plugin-dedicated Express router, mounted at:

```
/(api|ws|virtual_files)/parts/plugins:<plugin name>/<your registered path>
```

For example, `router.post('/config/setdata', handler)` in your plugin means the frontend calls `POST /api/parts/plugins:my-plugin/config/setdata`. All parts API requests pass through login authentication first; unauthenticated requests return 401.

### config getdata/setdata Convention

The general convention for frontend–plugin communication:

- `GET  /api/parts/plugins:<name>/config/getdata` → `interfaces.config.GetData()`
- `POST /api/parts/plugins:<name>/config/setdata` → `interfaces.config.SetData(data)`

The `data._action` field distinguishes action types (read file / write config / trigger operation …); a single SetData dispatches multiple operation types.

### Security-sensitive Configuration Must Register an Owner Gate

In a multi-user deployment, any logged-in user can call `config/setdata`. If your configuration items write **process-level global security state** (toggling the sandbox, allowing command execution, changing the workspace root …), they must be registered in the security-sensitive write list in `security_policy.mjs` — the framework enforces owner-only writes at the routing seam (case variants are also covered). Otherwise any registered user can flip your switch (RCE / sandbox escape surface).

### User Data Isolation

In multi-user scenarios, plugin configuration and data are isolated per user: store data using user data directories, or implement per-user context with AsyncLocalStorage (as beilu-files does). Note that `args.username` in GetPrompt/ReplyHandler is the source of the isolation key.

## Part 4: How to Connect — External Application Integration

External programs (games, scripts, third-party tools) do not go through plugins; they use the **`/api/v1` external interface**:

1. Settings → External Application Integration → Create API Key (select permission scope; the key is shown only once)
2. REST calls: `Authorization: Bearer <key>`, endpoints listed in [API Endpoint Reference](api-reference.md) (chat / characters / variables / memory / presets / worldbooks / tools / webhooks)
3. Real-time bridge: `ws://host/api/v1/game/connect?chatId=<id>&token=<key>` — send `{type:"send", content, sender}` to trigger an AI reply and automatically receive streaming tokens and message events
4. Outbound push: register a Webhook; when an AI reply completes, an HMAC-signed POST is sent to your URL

External input is sanitized (invisible characters stripped, protocol tags escaped, wrapped in `<external_user>` identity); bypassing sanitization requires a separate `chat:raw` scope. Dangerous operations (deleting conversations / modifying presets) require an `X-Beilu-Confirm: true` confirmation header.

## User Plugins (beilu-plugin-host)

Through beilu-plugin-host, users can load custom plugin scripts at runtime without restarting the service. User plugins have the same interface capabilities as built-in plugins but are subject to security policy constraints.

## Debugging

- `BEILU_DIAG=<module name>` environment variable enables diagnostic logging
- whitebox tracing (wbTrace / wbDetect) records key events, visible in the error panel
- fakeSend (token preview) mode tests GetPrompt / TweakPrompt output without actually sending

## Navigation

- [Plugin Overview](../plugins/overview.md) — Existing plugin list
- [Message Pipeline](message-pipeline.md) — Plugin position in the pipeline
- [System Architecture](architecture.md) — Overall architecture
- [API Endpoint Reference](api-reference.md) — Endpoint interfaces
