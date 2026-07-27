# Execution Pipeline

The complete data flow from AI output to actual IDE execution. Understanding this pipeline helps troubleshoot tool call failures.

## Main Pipeline: 10-Step Execution Flow

<div class="wiki-flow">
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">1. AI Output</div>
    The AI generates an &lt;ideToolCall&gt; tag in its reply, containing the tool name and parameters
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">2. ReplyHandler Parsing</div>
    The message pipeline's ReplyHandler intercepts the reply and parses out the ideToolCall tag
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">3. Read/Write Routing</div>
    Determines the tool type: read operations pass through directly; write operations enter a security check
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red">
    <div class="wiki-label">4. Security Check</div>
    Five-level security gate checks in sequence: Command Gate → Rule Set → Approval Gate → Unified Execution Gate → Fingerprint Binding
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-amber">
    <div class="wiki-label">5. Approval Queue</div>
    Operations requiring Approval enter the queue; the frontend displays an Approval card waiting for the user to approve or reject
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">6. callTool Dispatch</div>
    After Approval, callTool wraps the request into a WS message and sends it to the YonBan extension
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green">
    <div class="wiki-label">7. WebSocket Transport</div>
    The request is delivered to the YonBan extension running in the local IDE via a WS persistent connection
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green">
    <div class="wiki-label">8. ToolExecutor Execution</div>
    The YonBan extension's ToolExecutor performs the actual operation in the local IDE environment
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">9. Result Return</div>
    The execution result is sent back to the always-accompany backend via WS and queued for processing
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">10. Inject into Next Turn</div>
    The tool execution result is injected into the context of the next AI conversation turn, and the AI decides subsequent actions based on it
  </div>
</div>

## Four Call Paths

Tool calls are not limited to the AI-initiated path; there are four entry points:

| Path | Trigger | Description |
|------|---------|-------------|
| AI-initiated call | AI reply contains `<ideToolCall>` | Main pipeline; parsed by ReplyHandler and goes through the full security gate |
| Frontend manual call | User manually sends from the connection panel bottom | Select tool + fill parameters + send; bypasses the AI step and goes directly to callTool |
| Sub-agent call | Submode/sub-agent AI initiates | Same as the main pipeline, but may be bound to a different Permission level |
| dispatch scheduling | System-internal automatic trigger | e.g., automatic snapshots (_checkpoint_start), diagnostic pushes; internal tools bypass Approval |

## WebSocket Message Types

WS communication between the always-accompany backend and the YonBan extension uses the following message types:

| Message Type | Direction | Description |
|-------------|-----------|-------------|
| tool_call | Backend → Extension | Tool call request, containing the tool name and parameters |
| tool_result | Extension → Backend | Tool execution result, containing the return value or error information |
| hello | Extension → Backend | Connection handshake, reporting editor type/version |
| status | Extension → Backend | Extension status report (open files/active editor/diagnostic information) |
| console | Extension → Backend | IDE terminal/console output forwarding |
| ping / pong | Bidirectional | Heartbeat keepalive to detect connection liveness |

## Failure Troubleshooting

When a tool call fails, troubleshoot step by step along the pipeline:

| Symptom | Possible Break Point |
|---------|---------------------|
| AI did not call any tool | Step 1 — IDE tools not enabled in the Preset/prompt |
| Call was rejected | Steps 4-5 — Insufficient Permission level or rejected by the user |
| Call timed out with no response | Step 7 — WS connection disconnected; check the connection panel status light |
| Execution error | Step 8 — Local environment issue (file does not exist / insufficient permissions) |
| AI did not receive the result | Steps 9-10 — Result return or Injection anomaly |

## Navigation

- [YonBan Overview](overview.md) — Installation and connection
- [Tool List](tools.md) — 30+ tools quick reference
- [Approval and Permissions](approval.md) — Five-level security gate details
- [Message Pipeline](beilu:wiki/developer/message-pipeline.md) — ReplyHandler's position in the pipeline
