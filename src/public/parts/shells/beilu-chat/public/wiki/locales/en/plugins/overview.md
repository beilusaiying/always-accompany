# Plugin Manual

Plugins are not here to make a feature list longer. They connect memory, tools, perception, rendering, and external programs to the same message and permission chain, then let you compose an outcome.

If your first question is “what can this replace in my current workflow?”, begin with [Plugin Combinations](combinations.md) instead of memorizing plugin names.

The current source tree contains **23 built-in plugin directories**. The new-user defaultParts template lists 14; other plugins may load through a feature entry point, self-register, or remain optional.

> Three states are different: present in source, loaded for this user, and internally enabled/configured. For example, beilu-vectordb is listed by default while vector semantic search itself remains off.

## Choose by outcome

| Goal | Suggested combination | Confirm first |
|---|---|---|
| Long-term chat and companionship | memory + preset + worldbook + P1 | P1 route, resource cost, memory writes, recall trace |
| Voice, desktop, or live perception | STT + eye + live | Local models, screenshot scope, external-platform input |
| Local coding assistant | files + memory + CLI or YonBan + web | Workspace root, write approval, command permissions |
| Web research and action | web + browser + files | Search service, Chrome debug port, download/write boundaries |
| Deliverables | Work + files + PPT + web/browser | Python/Office dependencies, output path, approvals |
| Interactive narrative | worldbook + MVU + regex/EJS + AIRP | State truth source, script permissions, render fallback |
| Your own local service | plugin-host | Subprocess permission, localhost token, injection TTL |
| Semantic memory search | vectordb + memory | Embedding destination, model dimensions, index rebuild |

## All 23 built-in plugins

### Memory and prompts

| Plugin | User value | Default / entry | Manual |
|---|---|---|---|
| beilu-memory | Tables, layers, archives, recall, and mode task data | New-user default list | [Memory](../memory/overview.md) |
| beilu-preset | Prompt assembly, switching, model parameters, and submodes | New-user default list | [Presets](../presets/overview.md) |
| beilu-worldbook | Rule- and keyword-triggered lore or background | New-user default list | [Worldbooks](../memory/worldbook-overview.md) |
| beilu-p1-selfdriven | Local P1 service and resource lifecycle | Controlled by P1 master switch and mode route | [Current P1 Runtime (Chinese)](../../../p1-recall/ch7-current-runtime.md) |
| beilu-vectordb | Full-text, vector, and hybrid retrieval | Plugin listed by default; vector feature off | [Semantic Search](vectordb.md) |

### Tools and execution

| Plugin | User value | Default / entry | Manual |
|---|---|---|---|
| beilu-files | Sandboxed file operations and commands | New-user default list | [Files](files.md) |
| beilu-web | Web search and page retrieval | New-user default list; service configuration required | [Web](web.md) |
| beilu-browser | Control a real Chrome browser | Optional | [Browser](browser.md) |
| beilu-cli | Tool backend without an IDE | Starts with the main app by default; disableable or mutually exclusive with YonBan | [CLI](cli.md) |
| beilu-ppt | Generate and iterate pptx files | Used from Work as needed | [PPT](ppt.md) |
| beilu-reach | External-platform adapters | Platform-specific setup | [Reach](reach.md) |

### Perception and input

| Plugin | User value | Default / entry | Manual |
|---|---|---|---|
| beilu-eye | Desktop screenshots and companion input | New-user default list; perception still needs enablement | [Eye](eye.md) |
| beilu-stt | Local speech-to-text | Optional model download | [STT](stt.md) |
| beilu-live | Filter and inject live-chat events | Master switch off by default; enable per platform and scenario | [Live Input](live.md) |

### State, rules, and rendering

| Plugin | User value | Default / entry | Manual |
|---|---|---|---|
| beilu-mvu | Cross-turn variables and state | New-user default list | [MVU](mvu.md) |
| beilu-regex | Rule-based reply processing | New-user default list | [Regex](regex.md) |
| beilu-ejs | Conditional and loop templates in prompts and characters | New-user default list | [Scripts](scripts.md) |
| beilu-toggle | Dynamic preset and worldbook entry switches | New-user default list | [Presets](../presets/overview.md) |
| beilu-airp | Scene DSL rendered as symbols, colors, and effects | Self-registers per user when loaded; disableable | [AIRP](airp.md) |

### Extension and operations

| Plugin | User value | Default / entry | Manual |
|---|---|---|---|
| beilu-plugin-host | Run Python/Node/executable user plugins and receive injections | New-user default list; subprocess blocked in server mode | [User Plugin Host](plugin-host.md) |
| beilu-sysinfo | Configurable time and runtime information | Capability available; actual INJ entry off by default | [System Information](sysinfo.md) |
| beilu-logger | Recent server errors and warnings | New-user default list; in-memory ring buffer | [Logger](logger.md) |
| beilu-tutorial | Interactive tutorials, UI guidance, and visual-novel sequences | Used by tutorial/help entry points | [Tutorial](tutorial.md) |

## What each detailed manual should answer

1. What user job does it replace or simplify?
2. When should you not use it?
3. Is it present, loaded, or actually enabled?
4. Where is it configured?
5. What is the full input → plugin → execution/storage → result path?
6. Which data stays local and which leaves the machine?
7. Which actions require owner permission or approval?
8. Which modes and plugins combine well with it?
9. What are the known limits and diagnostic signals?

## Shared interface and permission rules

Open [Plugin Management](beilu:settings/plugins) to inspect current plugins. Common hooks include:

| Hook | Timing | Typical purpose |
|---|---|---|
| GetPrompt | Before an AI request | Memory, tool instructions, or external data |
| TweakPrompt | During prompt assembly | Adjust message structure and priority |
| GetReply | During generation | Intercept or alter generation |
| ReplyHandler | After the model reply | Parse operations, update state, adjust display |
| GetData | Panel read | Return configuration and status |
| SetData | Panel write / action | Save configuration, rebuild, start, stop, or trigger work |

A plugin need not implement every hook. Framework support does not prove a specific integration exists.

Sensitive features such as command execution, script sandbox escape, and user-plugin subprocesses have additional gates. Server mode uses more conservative defaults. See [Security](../security/overview.md) and [Authentication & Permissions](../security/auth.md).

## Two boundaries for composition

**Shared capability is not shared state.** Tool results, tasks, windows, and chat IDs must retain their owner even when several modes reuse a plugin.

**Editable is not automatically safe.** Review workspace roots, command permission, logged-in browser sessions, embedding endpoints, subprocess privileges, and the source of scripts or plugins.

## Quick links

- [Plugin Combinations](combinations.md)
- [Files](files.md)
- [Web](web.md)
- [Browser](browser.md)
- [Eye](eye.md)
- [Speech-to-Text](stt.md)
- [Reach](reach.md)
- [PPT](ppt.md)
- [MVU](mvu.md)
- [Regex](regex.md)
- [Scripts](scripts.md)
- [Semantic Search](vectordb.md)
- [AIRP](airp.md)
- [User Plugin Host](plugin-host.md)
- [Live Input](live.md)
- [CLI](cli.md)
- [System Information](sysinfo.md)
- [Logger](logger.md)
- [Tutorial](tutorial.md)
- [Built-in Plugin Development](../developer/plugin-dev.md)
