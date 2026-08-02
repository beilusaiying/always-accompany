# API Endpoint Reference

All HTTP/WS routes for beilu-chat are defined in `endpoints.mjs`. This document lists the main endpoints and their functionality. All endpoints are protected by the `authenticate` middleware (login required). See [Permissions & Authentication](../security/auth.md) for details.

## Route Prefix

The base path for all beilu-chat endpoints is `/api/shells/chat/`. The prefix is omitted from the endpoints below.

## Conversation Message Operations

Endpoints with `:chatid` as a path parameter go through `router.param("chatid")` centralized ownership validation — verifying that the requesting user has permission to operate on the conversation.

| Method | Path | Description |
|------|------|------|
| WS | `/ws/.../ui/:chatid` | Chat UI WebSocket connection |
| GET | `:chatid/initial-data` | Get initialization data when opening a conversation |
| GET | `:chatid/log` | Get chatLog (supports pagination) |
| GET | `:chatid/log/length` | chatLog length (`?visible=1` for non-hidden entries only) |
| POST | `:chatid/message` | User sends a message (R1 entry point, triggers AI reply) |
| PUT | `:chatid/message/:index` | Edit a specific message |
| DELETE | `:chatid/message/:index` | Delete a specific message |
| POST | `:chatid/trigger-reply` | Trigger AI reply only (without saving a user message) |
| POST | `:chatid/messages/delete-range` | Batch delete a range of messages |
| POST | `:chatid/messages/hide` | Hide/unhide a range of messages |
| PUT | `:chatid/timeline` | Switch timeline (greeting swipe) |
| GET | `:chatid/render/entries` | Regex activation fix: render query |

## Conversation Lifecycle

| Method | Path | Description |
|------|------|------|
| POST | `new` | Create a new empty conversation |
| DELETE | `delete` | Batch delete conversations |
| POST | `:chatid/rename` | Rename a conversation |
| POST | `:chatid/mode` | Set conversation mode badge |
| POST | `:chatid/using` | Mode window in-use pointer (mode:char -> chatid) |
| POST | `branch` | Branch a conversation |
| GET | `getchatlist` | Get the chat list |
| POST | `search` | Full-text search chat content |

## Conversation Metadata

| Method | Path | Description |
|------|------|------|
| GET | `:chatid/chars` | Character list in a conversation |
| GET | `:chatid/plugins` | Plugin list in a conversation |
| GET | `:chatid/persona` | Current persona name |
| GET | `:chatid/world` | Current world setting name |
| POST | `:chatid/char` | Add a character to a conversation |

## Character Card Management

| Method | Path | Description |
|------|------|------|
| POST | `create-char` | Create a blank Character Card |
| PUT | `update-char/:charName` | Update Character Card fields |
| DELETE | `delete-char/:charName` | Delete a Character Card (8-step cleanup) |
| POST | `import-char` | Import Character Card JSON/PNG (with regex + World Book migration) |
| GET | `char/:charName/export` | Export Character Card as PNG/JSON |
| GET | `char-data/:charName` | Get chardata.json |
| GET | `char-aisource/:charName` | Get character-bound AI Service Source + available source list |

## Persona Management

| Method | Path | Description |
|------|------|------|
| POST | `persona/create` | Create a persona |
| DELETE | `persona/:name` | Delete a persona |
| PUT | `persona/:name/update` | Update persona description + avatar |

## IDE Bridge

| Method | Path | Description |
|------|------|------|
| GET | `ide/wstoken` | Browser proxy-read IDE WS token |
| POST | `ide/connect` | Force backend ideClient to connect immediately |
| POST | `ide/manual-tool-call` | Manual panel tool call (goes through backend unified execution gate) |

## Parallel Group Management

| Method | Path | Description |
|------|------|------|
| GET | `groups` | List all groups for the current user |
| POST | `groups` | Create a new group |
| PUT | `groups/:groupId` | Update group fields |
| DELETE | `groups/:groupId` | Delete a group (including worker termination) |
| POST | `groups/:groupId/role` | Bind a role within a group to a chatid |
| DELETE | `groups/:groupId/role/:role` | Unbind a role within a group |
| GET | `groups/engine` | Parallel engine toggle status |
| POST | `groups/engine` | Toggle parallel engine on/off |
| POST | `groups/:groupId/execute` | Start conversations for all roles in a group |

## Plugin Configuration Endpoints

Plugin configuration is accessed through the parts_router's unified endpoints (not specific to beilu-chat):

| Operation | Endpoint | Description |
|------|------|------|
| Read config | `GET /api/parts/:partpath/config` | Get plugin configuration |
| Write config | `POST /api/parts/:partpath/config` | Update plugin configuration |
| Read data | `GET /api/parts/:partpath/data` | Call GetData |
| Write data | `POST /api/parts/:partpath/data` | Call SetData |

Security-sensitive config/setdata writes go through `partConfigWriteNeedsOwner` checks, requiring owner privileges when matched.

## WebSocket Events

always-accompany uses WebSocket for real-time communication. Main events:

### Server -> Client

| Event | Description |
|------|------|
| `message_added` | New message added (user message / AI reply placeholder) |
| `message_replaced` | Message replaced (AI reply finalized / hide range updated) |
| `message_edited` | Message edited |
| `message_deleted` | Message deleted |
| `stream_start` | AI streaming reply started |
| `stream_update` | AI streaming reply new fragment |
| `token_usage` | Token usage statistics |
| `typing_status` | Typing status (peer activity indicator during parallel groups) |
| `auto_continue_fuse` | Auto-continue circuit breaker notification |

### Client -> Server

| Event | Description |
|------|------|
| `stop_generation` | Stop current generation |

## Authentication Requirements

| Endpoint Type | Authentication Level |
|---------|---------|
| All API endpoints | authenticate (login required) |
| Security-sensitive config | requireOwner (instance owner required) |
| API v1 external calls | API Key + scope validation |

## Error Responses

| Status Code | Description |
|--------|------|
| 401 | Unauthenticated (not logged in or token expired) |
| 403 | Unauthorized (not owner / conversation does not belong to current user) |
| 404 | Conversation / character / resource not found |
| 500 | Internal server error |

## Navigation

- [System Architecture](architecture.md) — Overall architecture
- [Message Pipeline](message-pipeline.md) — Message flow
- [Permissions & Authentication](../security/auth.md) — Authentication system
- [Plugin Development](plugin-dev.md) — Custom plugins
