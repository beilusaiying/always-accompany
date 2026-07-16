# Plugin Development

always-accompany's plugin system allows you to write custom plugins to extend functionality. Plugins participate in the [message pipeline](message-pipeline.md) through standardized interfaces, and can inject prompts for the AI, process AI replies, provide configuration panels, and more.

## Plugin Structure

The minimal directory structure of a always-accompany plugin:

```
plugins/my-plugin/
├── info.json          ← Plugin metadata (required)
├── main.mjs           ← Plugin entry point (required)
└── (optional) display.mjs ← Frontend configuration panel
```

### info.json

The plugin's metadata file, discovered and read by parts_loader:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Plugin feature description",
  "version": "1.0.0"
}
```

Or use the `beilu-part.json` format (both are recognized by parts_loader).

### main.mjs

The plugin entry file. Exports an object containing interfaces:

```javascript
export default {
  info: { /* plugin info */ },
  interfaces: {
    chat: {
      GetPrompt,     // Inject prompts
      TweakPrompt,   // Adjust prompts
      ReplyHandler,  // Process AI replies
    },
    config: {
      GetData,       // Read configuration
      SetData,       // Write configuration
    },
  },
};
```

## Interface Details

### GetPrompt

Called before a message is sent; returns the content the plugin wants to inject into the prompt.

**Parameters**: `(chatReplyRequest)`

**Return value**: A `single_part_prompt_t` object containing:

```javascript
{
  text: [
    { content: "Prompt text", important: 0 }
  ],
  extension: {
    // Data passed between plugins (not sent directly to AI)
  }
}
```

- `text[]`: Text fragments to inject into the prompt, sorted by important
- `extension`: Extension data for other plugins to read during the TweakPrompt phase

### TweakPrompt

Called after all GetPrompt calls complete, allowing modification of the assembled prompt_struct. Executes in three rounds:

**Parameters**: `(prompt_struct, chatReplyRequest, detail_level)`

- `prompt_struct`: The current prompt structure (can be modified directly)
- `detail_level`: The current round (2 -> 1 -> 0)

**Return value**: None (modifies prompt_struct directly)

Typical usage:
- Round 1 (dl=2): Read other plugins' extension data
- Round 2 (dl=1): Reorganize message sequences
- Round 3 (dl=0): Final adjustments

### ReplyHandler

Called after the AI reply arrives, used to parse and process specific tags in the reply.

**Parameters**: `(replyText, chatReplyRequest)`

**Return value**: Processed text (can modify reply content)

Typical usage:
- Parse custom tags in the AI reply
- Execute operations corresponding to tags (file read/write, variable setting, etc.)
- Inject operation results into the next round via GetPrompt

### GetData

Called when the frontend or other modules read plugin configuration/state.

**Parameters**: `(request)`

**Return value**: Configuration data object

### SetData

Called when the frontend or other modules write plugin configuration or trigger actions.

**Parameters**: `(data, request)`

The `_action` field in `data` can be used to distinguish between different operation types.

## Inter-plugin Communication

Plugins do not directly import each other. Instead, they communicate indirectly through the `extension` field of `prompt_struct`:

1. Plugin A writes data to `extension.my_data` during the GetPrompt phase
2. Plugin B reads from `prompt_struct.plugin_prompts['plugin-a'].extension.my_data` during the TweakPrompt phase

This loosely-coupled design ensures plugins can be developed and deployed independently.

## Plugin Loading

### Auto-loading

Plugins listed in `defaultParts.plugins` are automatically loaded in every conversation.

### Loading Order

parts_loader loads plugins in directory order during server startup. Module-level code in plugins executes at load time — be careful to avoid blocking and circular dependencies.

If you need to reference other modules, use lazy dynamic imports (loaded on first use) to avoid loading order issues.

## Security Considerations

### Security-sensitive Configuration

If your plugin has security-sensitive configuration options (such as toggling the Sandbox, allowing command execution, etc.), they need to be registered in `security_policy.mjs`'s `OWNER_ONLY_PART_CONFIG_WRITE` table to ensure these configurations can only be modified by the owner.

### User Data Isolation

In multi-user scenarios, plugin configuration and data should be isolated per user. Use `getUserDataDir(username)` to obtain user data paths, or use AsyncLocalStorage to implement per-user context.

### Frontend Configuration Panel

Return frontend configuration panel JavaScript code through the `GetConfigDisplayContent` interface. The panel executes in the browser — be careful not to expose sensitive information.

## User Plugins (beilu-plugin-host)

Through beilu-plugin-host, users can load custom plugin scripts at runtime without restarting the service. User plugins have the same interface capabilities as built-in plugins but are subject to security policy constraints.

## Testing

Recommendations for plugin development:

- Use the `BEILU_DIAG=<module-name>` environment variable to enable diagnostic logging
- Record key events through the whitebox tracing system (wbTrace / wbDetect)
- Use fakeSend (token preview) mode to test GetPrompt / TweakPrompt output

## Navigation

- [Plugin Overview](../plugins/overview.md) — Existing plugin list
- [Message Pipeline](message-pipeline.md) — Plugin position in the pipeline
- [System Architecture](architecture.md) — Overall architecture
- [API Endpoint Reference](api-reference.md) — Endpoint interfaces
