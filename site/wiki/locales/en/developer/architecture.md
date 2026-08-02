# System Architecture

always-accompany uses a Deno backend + vanilla frontend, with functionality organized through the parts system.

## Tech Stack

| Layer | Technology |
|---|------|
| Runtime | Deno (Node.js compatible) |
| Backend Framework | Express |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Real-time Communication | WebSocket |
| Data Storage | JSON file system (no database) |

## Directory Structure

```
beilu-always-accompany/
├── src/
│   ├── server/              ← Server core (startup/routing/middleware)
│   ├── scripts/             ← Shared script utilities
│   ├── public/
│   │   └── parts/
│   │       ├── shells/      ← Shells (UI + endpoints)
│   │       │   └── beilu-chat/  ← Main shell
│   │       ├── plugins/     ← Plugins
│   │       └── serviceGenerators/ ← AI service generators
│   └── yonban/              ← Core function library (migrated implementations)
│       └── core/
│           ├── functions/   ← General-purpose stateless functions
│           │   ├── api/     ← AI API calls (6 providers)
│           │   ├── prompt/  ← Preset engine + Macros + variables
│           │   ├── memory/  ← Memory system
│           │   ├── security/ ← Security system
│           │   ├── screenshot/ ← Screenshot awareness
│           │   ├── web/     ← Web search
│           │   ├── regex/   ← Regex engine
│           │   └── ...
│           ├── pipelines/   ← Pipeline runtime
│           └── transport/   ← IDE bridge
├── data/                    ← User data (generated at runtime)
│   ├── config.json          ← Global configuration
│   └── users/               ← User data (per-user isolation)
│       └── <username>/
│           ├── shells/chat/ ← Conversation data
│           ├── presets/     ← Preset files
│           └── ...
└── desktop-eye/             ← Desktop pet Electron + Python screenshot
```

## Parts System

### Three Types of Parts

| Type | Directory | Description |
|------|------|------|
| Shell | parts/shells/ | Provides UI + HTTP endpoints, the "outer shell" of the system |
| Plugin | parts/plugins/ | Feature extensions that participate in the message pipeline through standard interfaces |
| Service Generator | parts/serviceGenerators/ | AI API call implementations |

<div class="wiki-grid wiki-grid-3">
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: var(--beilu-amber-fg);">Shell</div>
    <div class="wiki-card-desc">Provides UI interfaces and HTTP endpoints. The "outer shell" of the system — the entry point for direct user interaction.</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/shells/</span></div>
  </div>
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: oklch(0.65 0.15 300);">Plugin</div>
    <div class="wiki-card-desc">Feature extension modules that participate in the message pipeline through standard interfaces such as GetPrompt / TweakPrompt / ReplyHandler.</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/plugins/</span></div>
  </div>
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: oklch(0.65 0.15 150);">Service Generator</div>
    <div class="wiki-card-desc">Concrete implementations of AI API calls, encapsulating request/response differences across providers.</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/serviceGenerators/</span></div>
  </div>
</div>

### Loading Mechanism

`parts_loader.mjs` is responsible for discovering and loading all Parts:

- Scans for `beilu-part.json` / `info.json` by directory convention
- Loads each Part's `main.mjs` (entry file)
- Extracts the interfaces object and registers various interface types (GetPrompt / TweakPrompt / ReplyHandler, etc.)

### Thin-Shell Re-export Pattern

After the yonban migration, many plugins' `main.mjs` became thin shells — they only re-export, with the actual code residing in `yonban/core/functions/`. Thin shells are never deleted (P-type thin shells), because parts_loader discovers and loads them by directory convention.

## yonban Layer

yonban is always-accompany's core function library layer. The difference from parts:

- **parts**: Follow the always-accompany plugin protocol, with info.json and interfaces
- **yonban**: Pure function modules, referenced by parts and the server core

### Migration Background

Originally all code lived in the parts directory. The yonban migration consolidated "general-purpose stateless backend functions" into `core/functions/<group>/`, resulting in cleaner code organization and higher reusability.

## Data Layer

always-accompany uses JSON files rather than a database. Data operations ensure consistency through atomic writes (tmp + rename).

### Per-user Data Isolation

Under `data/users/<username>/`, each user has an independent data directory. Key data paths are obtained through the authoritative function `getUserDataDir(username)`.

### Data Files

| File | Description |
|------|------|
| config.json | Global configuration (Owner/keys/user list) |
| users/\<user\>/shells/chat/\<chatid\>.json | Conversation data |
| users/\<user\>/presets/config.json | Preset configuration |
| users/\<user\>/presets/registry.json | Preset registry |
| users/\<user\>/presets/\*.json | Preset files |

## Inter-module Dependency Principles

- **Security modules** (path_confine / auth / security_policy) sit at the bottom of the dependency hierarchy and do not reference upper-layer modules
- **parts_loader** belongs to the server domain and is referenced by endpoints / requestBuilder
- **Plugins communicate indirectly** through the extension field (no direct imports between plugins)
- **Circular dependencies** are broken through lazy dynamic imports

<div class="wiki-layers">
  <div class="wiki-layer wiki-layer-amber">
    <span class="wiki-layer-label">Shell Layer</span>
    UI + endpoints — user request entry point, calls lower-layer services
  </div>
  <div class="wiki-layer wiki-layer-purple">
    <span class="wiki-layer-label">Plugin Layer</span>
    Feature extensions — communicate indirectly via extension, no cross-imports
  </div>
  <div class="wiki-layer wiki-layer-blue">
    <span class="wiki-layer-label">Server Layer</span>
    parts_loader / endpoints / requestBuilder — loading and dispatch
  </div>
  <div class="wiki-layer wiki-layer-green">
    <span class="wiki-layer-label">yonban Layer</span>
    Core function library — pure function modules, referenced by upper layers
  </div>
  <div class="wiki-layer">
    <span class="wiki-layer-label">Security Layer</span>
    path_confine / auth / security_policy — bottom layer, does not reference upper layers
  </div>
</div>

## Navigation

- [Message Pipeline](message-pipeline.md) — Full message flow chain
- [Plugin Development](plugin-dev.md) — Writing custom plugins
- [API Endpoint Reference](api-reference.md) — HTTP/WS interfaces
- [Security Center](../security/overview.md) ([Open Panel](beilu:settings/security)) — Security architecture
