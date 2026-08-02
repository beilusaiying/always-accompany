# Message Pipeline

The message pipeline is the complete data flow in always-accompany from the user sending a message to the AI reply being displayed. Understanding this chain is the key to understanding how always-accompany works.

## Full Chain Overview

<div class="wiki-flow">
  <div class="wiki-box wiki-box-amber wiki-box-full"><b>User sends a message in the frontend</b></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>POST /:chatid/message</b><small>endpoints.mjs</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>addUserReply</b><small>chatOps.mjs — saves the user message to chatLog</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>triggerCharReply</b><small>generation.mjs — triggers AI reply</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>getChatRequest</b><small>requestBuilder.mjs — builds the request object</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>buildPromptStruct</b><small>Assembles the prompt structure</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-group" style="width:100%;max-width:480px;">
    <div class="wiki-group-title">Plugin Participation Phase</div>
    <div class="wiki-flow" style="margin:0;">
      <div class="wiki-box wiki-box-purple wiki-box-full"><b>Each plugin's GetPrompt</b><small>Collects prompt fragments in parallel</small></div>
      <div class="wiki-arrow">↓</div>
      <div class="wiki-box wiki-box-purple wiki-box-full"><b>Each plugin's TweakPrompt × 3 rounds</b><small>Adjusts the prompt structure</small></div>
    </div>
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>executeGeneration</b><small>generation.mjs</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>GetReply → StructCall</b><small>provider — calls AI API</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>AI streaming response</b><small>StreamManager pushes chunk by chunk</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple wiki-box-full"><b>Each plugin's ReplyHandler</b><small>Parses operation tags in the reply</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>finalizeEntry</b><small>Builds the message entry</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>addChatLogEntry</b><small>chatOps.mjs — saves AI reply to chatLog</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>broadcastChatEvent</b><small>WS push to frontend</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>Auto-continue decision</b><small>Whether to continue generating</small></div>
</div>

## Phase Details

### 1. User Sends a Message

The frontend sends the user message via the `POST /:chatid/message` endpoint. After passing `router.param("chatid")` ownership validation, the request is handed off to chatOps for processing.

### 2. Save User Message

`addUserReply` constructs the user message as a `chatLogEntry_t`, pushes it to the chatLog array, saves it to disk, and broadcasts a `message_added` event to the frontend via WS.

### 3. Build Request Object

`getChatRequest` is responsible for assembling the complete `chatReplyRequest_t` object:

- Loads conversation metadata (chatMetadata)
- Resolves user and character information
- Merges default plugins (plugins from getAllDefaultParts participate even if not in an older chat's timeSlice)
- Retrieves visible chat log (getVisibleChatLog)

### 4. Assemble Prompt Structure

`buildPromptStruct` calls the pipeline runtime (yonban pipelines), triggering GetPrompt and TweakPrompt for all Parts:

#### GetPrompt Phase

Each plugin returns the text fragments it wants to inject into the prompt. Return values go into the corresponding areas of `prompt_struct`:

- `char_prompt` — Character-related prompts
- `user_prompt` — User-related prompts
- `world_prompt` — World/environment-related prompts
- `plugin_prompts` — Plugin prompts (partitioned by plugin name)

beilu-preset's GetPrompt returns an empty shell (the Preset's real work happens in the TweakPrompt phase).

#### TweakPrompt Three Rounds

All plugins' TweakPrompt functions execute across three rounds in decreasing detail_level:

| Round | dl Value | Core Action |
|------|-------|---------|
| Round 1 | 2 | Collect and clear — reads each module's prompts into the Macro environment env, clears original modules |
| Round 2 | 1 | Rebuild messages — the engine's buildAllEntries() produces four message segments, merges model_params |
| Round 3 | 0 | Snapshot — records a debug snapshot (commanderSnapshot), no further changes to chat_log |

### 5. AI API Call

`executeGeneration` is the streaming generation core. It calls the provider's StructCall through the GetReply interface:

- **StructCall** receives prompt_struct, calls `assembleCommanderMessages` (Commander Mode) or directly assembles messages
- **applyModelParams** maps canonical parameters to the provider-specific shape
- Initiates an HTTP/SSE streaming request, returning chunk by chunk

### 6. Streaming Response Processing

StreamManager manages the streaming response:

- Parses SSE data chunk by chunk
- Broadcasts `stream_start` / `stream_update` events to the frontend via WS
- The frontend displays the AI reply character by character

### 7. ReplyHandler Parsing

After the AI reply completes, each plugin's ReplyHandler processes it in sequence:

- **beilu-files**: Parses `<file_op>` / `<tool_call>` tags, executes file operations
- **beilu-regex**: Executes regex substitution rules
- **beilu-mvu**: Parses variable operation commands
- **beilu-memory**: Parses `<tableEdit>` tags, updates Memory Tables
- **beilu-web**: Parses `<search>` / `<browse>` tags, triggers web requests

### 8. Save and Broadcast

`finalizeEntry` builds the final AI message entry (chatLogEntry_t), which is saved to chatLog and broadcast via `addChatLogEntry`.

### 9. Auto-continue

If the AI's reply triggers a continuation condition (e.g., executing a coding task, needing to continue after a tool call), the system automatically triggers a new round of `triggerCharReply`.

Auto-continue has safety limits:
- No continuation count limit, controllable via panel switch
- Empty reply retry limit (EMPTY_REPLY_MAX_RETRIES = 3)
- fuzzy_edit consecutive failure circuit breaker (FUZZY_FAIL_LIMIT = 3)
- Loop auto-continue: inject custom text and continue when AI finishes without tool calls

## Module Responsibility Boundaries

| Module | Responsible For | Not Responsible For |
|------|--------|---------|
| endpoints.mjs | HTTP parameter validation + delegation | Not responsible for generation logic |
| requestBuilder.mjs | Request object assembly | Not responsible for generation scheduling |
| generation.mjs | Trigger -> streaming generation -> persist -> continue | Not responsible for prompt assembly |
| chatOps.mjs | Message CRUD + write operations | Not responsible for AI generation |
| chatStorage.mjs | Storage path resolution + persistence | Not responsible for message operations |
| prompt_struct.mjs | Prompt structure definition + serialization | Not responsible for plugin invocation |

## RT-4 Global Contract

All operations that change chatLog and need to notify the frontend must first `await saveChat` (persist), then `broadcastChatEvent` (WS push). If the order is reversed, the frontend may read stale data when it refetches the endpoint after receiving the WS event.

## Navigation

- [System Architecture](architecture.md) — Overall architecture
- [Preset System Overview](../presets/overview.md) — Preset engine
- [Commander Mode](../presets/commander.md) — Five-segment assembly
- [Plugin Overview](../plugins/overview.md) — Plugin interfaces
