<p align="center">
  <img src="imgs/icon.jpg" alt="always-accompany" width="180">
</p>

<h1 align="center">always-accompany</h1>

<p align="center"><strong>A multi-purpose AI + Agent project focused on context and attention mechanisms</strong></p>

<p align="center">Companionship, chat, coding, and work share one memory and context framework — the kind of AI you see in science fiction: it keeps you company, and it gets things done with you.</p>

<p align="center"><strong>Dynamic attention · Fixed injection · Project isolation · Specialized modes</strong></p>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Give_a_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center">English · <a href="README_CN.md">简体中文</a> · <a href="README_TW.md">繁體中文</a> · <a href="README_JA.md">日本語</a> · <a href="README_KO.md">한국어</a> · <a href="README_RU.md">Русский</a> · <a href="README_DE.md">Deutsch</a> · <a href="README_ES.md">Español</a> · <a href="README_FR.md">Français</a> · <a href="README_PT.md">Português</a></p>

> [!NOTE]
> **Development note:** Most of this project was built by one person in about three months, followed by roughly one month focused on algorithm optimization. Given the short development cycle and broad feature scope, the current project structure, basic features, and edge-case handling may still be unstable or incomplete. AI assisted with some basic features, while the author personally planned and directed the frameworks, algorithms, and key designs for complex features, so maturity varies across modules. Manual review, fine-tuning, and engineering improvements will continue. If you encounter a bug, please provide reproduction steps and logs.
>
> **What comes next:** New plugins and feature areas will no longer be added. Work will focus on reducing the core, lowering coupling, and gradually moving separable features into the plugin layer. The project will complete a detailed, stable plugin protocol before framework-level engineering optimization and incremental refactoring, while also improving tests, documentation, and contribution workflows so more developers can understand, extend, and contribute to it.

---

## What can it do right now?

- Hold long-term chat and roleplay, with direct import of SillyTavern community formats such as character cards, presets, and worldbooks;
- Read and modify project files and run commands like a local Agent workbench;
- Extend beyond the browser through a Live2D / image desktop companion, screen awareness, game companionship, voice input, and a Bot system covering nine platforms;
- Keep long-term material in local files, automatically find the excerpts relevant to the current question on each turn, and let old context that is no longer needed exit;
- Edit characters, prompt content and order, injection role and position, conditional trigger rules, memory-recall routes, permissions, and plugins — reshaping it into your own AI.

**What do we have?** Behind these interfaces is a single system, and the real differences come down to four things:

- **Layered memory and context** — Data plus `hot / warm / cold` layers store long-term material, and a context-gathering, memory-retrieval tool (P1) recalls currently relevant excerpts before each reply; context cleanup works at file-read granularity and is reversible, and the AI can also drop already-read files it no longer needs;
- **Core behavior is inspectable and configurable** — characters, prompts, injections, memory, recall routes, permissions, and plugins have documented editing or configuration entry points;
- **A plugin-based extensible framework** — core features are organized as plugins and routed through an intermediate relay station, while the frontend renders and operates them; user plugins can be written in JS, Python, or as standalone programs;
- **An integrated agent toolchain** — it provides files, commands, browser integration, MCP, multiple windows, approvals, and recovery under one memory and context framework; actual availability and results depend on the selected mode, configuration, environment, model, and connected services.

---

## Quick start

You only need two things:

- A working AI API;
- The ability to write simple prompts.

With those two, you can jump in and try it right away. One thing to say up front: the AIRP and Chat prompts are still being refined — for now the focus is on productivity, and the companionship-oriented polish will be filled in over time.

If you just want to start chatting, that is the entire cost. The self-driven P1 local retrieval service (currently measured peak memory on the order of ~2 GiB) can be switched off entirely; P1 parameters, prompt injection positions, Code, Work, and plugins are all configuration you go deeper into as needed, not a prerequisite course for first use.

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# or chmod +x run.sh && ./run.sh   # Linux / macOS
```

The launcher downloads the Deno runtime automatically when it is missing and completes installation when dependencies are incomplete. Your browser normally opens when the interface is ready; you can also visit `http://localhost:1314` manually.

| 1. Choose the interface language | 2. Bind an AI service source |
|---|---|
| ![Choose language](imgs/screenshots/onboarding-language.png) | ![Bind an API](imgs/screenshots/onboarding-api.png) |

Enter the service URL, API key, and model, save, then select or import a character card to start chatting. At least one working AI API is required; model capability and cost depend on the service you bind. A [Wiki](site/wiki/getting-started/overview.md) is built into the app, with an [online version](https://beilusaiying.github.io/always-accompany/) also available.

> First launch usually takes longer: the runtime downloads dependencies and initializes local data. Wait until the full page appears before interacting; later launches are faster. Optional features such as voice and the desktop companion may have their own first-use downloads or environment requirements.

---

## Feature overview

<table>
<tr>
<td width="33%">

**💬 Chat / Roleplay**
![Chat interface](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE Coding Mode**
![IDE coding](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Work Mode and PPT**
![Work mode PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D Companion + Screen Awareness**
![Desktop companion](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Six Permission Templates + Per-Tool Rules**
![Permission settings](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Tiered Compression × Line-by-Line Control**
![Compression mechanism](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧭 Four main modes + auxiliary views**: Smart (fully autonomous), Chat (chat / roleplay), Code (coding), and Work each have their own memory tables and P1 routes; there are also auxiliary views for Bot management, game companionship, memory management, ST adaptation, and more;
- **🧠 Data (editable structured memory tables) + three memory layers**: Data and ordinary `hot / warm / cold` JSON / Markdown files hold current facts, recent material, and archives respectively; everything can be viewed and edited;
- **🎯 P1 (front-loaded memory recall)**: before the main AI answers, it searches the long-term material the current character and mode are allowed to read for relevant excerpts. Chat / Code / Work currently default to a local algorithmic route; Smart / Bot modes retain a separate AI retrieval route; the two routes are mutually exclusive and can also be disabled;
- **🗜️ Context management**: inspect usage by message, file read, tool result, and system injection; normal cleanup merely hides content and stops sending it to the AI, while the record stays on disk and can be restored;
- **📊 Mode-specific memory tables**: Chat uses tables #0–#9, while Code and Work use their own tables and private directories instead of piling every scenario into one table;
- **👑 Main prompt entries are editable**: character definitions, presets, INJ entries, mode instructions, memory data slots, and tool guidance expose content, order, enablement, role, injection-position, or condition controls where supported; framework safety wrappers and provider-specific message transforms remain code-owned;
- **💻 IDE-level workflow**: three-panel layout, file reads and edits, command execution, task lists, multiple windows, and a VS Code extension bridge;
- **🔌 MCP (protocol for connecting external tools)**: paste JSON to connect external tools; command-type servers must pass owner, environment-variable allowlist, and other security gates;
- **🐾 Desktop and game companionship**: Live2D / image packs, three screen-awareness modes, proactive comments, a separate game-companionship loop, and adaptive frequency;
- **🎙️ Local voice input**: local MOSS-Transcribe-Diarize transcription with speaker separation and timestamps; it currently only converts speech to text and does not include AI voice playback;
- **🤖 Bots for nine platforms**: the current source tree includes shells for Discord, Telegram, Slack, LINE, Lark / Feishu, DingTalk, WeChat, WeCom, and X; each platform still requires its own token, webhook, or third-party bridge setup;
- **🔎 Optional semantic vector search**: built-in beilu-vectordb (based on Orama, supporting full-text / vector / hybrid search), off by default and enabled only after you configure your own embedding endpoint; complementary to self-driven P1 rather than an either-or choice;
- **🧩 Plugin system**: the current source tree contains 23 built-in plugin directories, while the new-user template lists 14 by default; user plugins can also be written in Python, Node, or as standalone programs;
- **🛡️ Local data and recovery**: application data is stored on your machine, with hidden restore, recycle, and backup chains; content sent to a remote AI or remote embedding service is still governed by the data policy of the service you chose;
- **🌐 Languages · 🔬 white-box diagnostics · 🎨 multiple themes**: beyond the core Chinese / English / Japanese / Traditional Chinese interfaces, additional community translations are provided and may be incomplete for lower-resource languages.

---

## What are we actually trying to solve?

Saving memory is not mysterious in itself. Data is a writable table, and `hot / warm / cold` are, put plainly, three folders you organize by "time + event" and jot Markdown notes into; INJ (editable prompt-injection entries) and presets likewise carry forward the prompt-composition approaches long explored by roleplay frontends such as SillyTavern.

Combine them with P1 (a tool that gathers context and retrieves memory), and they form a configurable workflow of "vectors + dynamic injection + memory that follows the current task"; file-level context cleanup is part of the same chain. Recall and compression results still depend on the selected mode, configuration, material, and model.

In fact, at first we planned to build P1 as a small AI deployed on its own. But the real problem starts after storage: as memory keeps piling up, if every turn has to spin up a second AI to dig through it, can the speed and cost still hold up? Can a small AI really find everything? Does it have to be a paid AI? Does remembering more mean responding more slowly?

In everyday use, it comes down to a few familiar moments: on a large project, you have the AI read the call chain, the framework, and the Markdown notes before you hand it a task — but halfway through, the token budget is nearly full, and one compaction means rereading everything; when several agents run together, context becomes an outright disaster; in a long task the AI keeps rereading the same file that only changed a few lines, context piles up until it bursts, yet you can't delete it; sometimes you meant to start a new project, but the AI anchors straight onto the memory of the old one.

These are not conjured out of thin air:

- [Issue #6](https://github.com/beilusaiying/always-accompany/issues/6)
- [Codex #35226](https://github.com/openai/codex/issues/35226) · [Claude Code #34556](https://github.com/anthropics/claude-code/issues/34556);
- [community discussion](https://www.reddit.com/r/SillyTavernAI/comments/1q7p33c/how_longterm_memory_works_in_sillytavernai/);
- Users of web chat products are also raising project-memory transparency and cross-project leakage concerns: [retrieval transparency request](https://community.openai.com/t/feature-request-make-project-memory-transparent-searchable-and-user-controlled/1385159) · [project-specific memory request](https://community.openai.com/t/project-specific-memory-in-chatgpt/1140856).

### After storage, how does it reach the AI?

Through the project's own **P1 front-loaded memory recall**: it first expands retrieval cues around the user's current conversation, then finds the relevant source text in the long-term material the current character and mode are allowed to read, and hands it to the main AI. You can think of it as a dynamic attention mechanism running outside the model — the current question decides what to look for, the long-term material supplies the candidates, and only the excerpts selected this turn enter the reply.

In practice this means: you do not have to repeat the original sentence — a related but not identical remark can also bring an old matter back; and after recall, the interface shows which memories were actually used this turn — what you verify is the record itself, not the AI saying "I remember."

---

## How it works in detail

<details>
<summary><strong>🧠 Data and Three-Layer Recursive Memory — Why Keep Layers at All?</strong></summary>

`hot / warm / cold` are first of all readable, writable lifecycle directories, not a mysterious database:

```text
🔥 hot  — recent, frequent, currently active material
🌤️ warm — phase-level organization and archive material
❄️ cold — deeper long-term history
📊 Data — editable, verifiable structured facts for the current mode
```

Layers give fixed injection, on-demand recall, and deep archives different costs and purposes. Source material stays in ordinary JSON / Markdown files where users can inspect and correct it directly; P1 then decides which layers should contribute excerpts this turn.

Long-context research has observed position bias and reduced utilization as tasks grow more complex: [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) · [RULER](https://arxiv.org/abs/2404.06654) · [Found in the Middle](https://aclanthology.org/2024.findings-acl.890/). These papers show that "fits in the window" and "reliably used" are not the same thing, but they do not directly prove this project's approach is better.

</details>

<details>
<summary><strong>🗜️ Context Management — From Whole-Thread Compression to File-Read-Level Cleanup</strong></summary>

Running real tasks generates a lot of process content: repeatedly read files, old tool results, already-consumed command tags, and stale messages. always-accompany provides automatic compression, cleanup by type, and line-by-line selection at the same time; default cleanup uses a `_hidden` marker so the record stays on disk but is no longer sent to the AI.

The AI can also emit `<contextClean>` to request cleanup; the system protects the user's original words and can enforce a minimum token threshold to avoid repeatedly breaking the prompt cache while the context is still small. Permanent or high-risk actions should not be mixed up with normal hiding.

| Tiered compression and granularity | File-read-level cleanup |
|---|---|
| ![Tiered compression panel](imgs/screenshots/compression-multi.png) | ![File-read-level cleanup](imgs/screenshots/context-file-cleanup.png) |

Most users only need to select the file reads or messages they no longer need; when you want deeper control, inspect the token bill, type, age, and source.

</details>

<details>
<summary><strong>🔬 Self-Driven P1 — An External Dynamic Memory-Attention Chain</strong></summary>

The current production chain is Node0–4, not the 21-node description in older documents:

```text
Node0  current input + recent user messages + current-mode Data
  ↓
Node1  tokenization, POS, time, proper-noun, and phrase anchors
  ↓
Node2  association expansion from SWOW / ConceptNet / Cilin / ATOMIC / domain terms
  ↓
Node3  multi-evidence signal filtering with BLQ (in-house algorithm) / NB300 / WordNet and more
  ↓
Node4  return to Data, hot / warm / cold, and mode records; rank with BM25, time, layer, Top, importance, and other signals
  ↓
recalledRecords + directionWords + trace
```

Associated words are not memory facts; candidates must return to the real-record layer before they can become final recall results. The white-box panel shows input units, per-node candidates and removal reasons, index state, final sources, and errors, making it possible to tell whether "nothing was recalled" means no match, degraded resources, or a broken chain.

![Self-driven P1 white-box test](imgs/screenshots/p1-self-driven-diagnostics.png)

The white-box panel proves that every node and real source can be inspected; recall quality still needs to be evaluated on the same corpus, the same tasks, and gold-labeled data. See the [current P1 production contract](site/wiki/p1-recall/ch7-current-runtime.md) for the full runtime boundary.

</details>

<details>
<summary><strong>👑 Main Prompt Entries Are Editable — Usable by Default, Configurable for Your Workflow</strong></summary>

Main prompt entries such as character definitions, presets, INJ entries, mode instructions, memory data slots, and tool guidance can be edited in the interface. For each supported entry you can adjust the controls it exposes; framework safety wrappers and provider-specific message transforms remain code-owned:

- the actual text;
- ordering;
- whether it is enabled;
- whether it is sent as system, user, or assistant;
- where it is inserted in chat history;
- whether it applies only to Chat, Code, Work, Bot, or under specified conditions.

</details>

<details>
<summary><strong>🔒 The AI Can Act, but Each Action Has Its Own Boundary</strong></summary>

File writes resolve to `deny / ask / allow` by tool, path, and three-state rules; commands additionally pass blacklist, graylist, and remote allowlist checks; sensitive configuration and subprocess capabilities in server deployments must be enabled by the owner.

L0–L5 are a set of quick templates from strict control to full allow, and users can keep refining down to individual tools and paths. L5 skips approvals and is an explicit high-risk choice; workspace confinement, deployment mode, and each plugin's own security gates should still be understood separately.

![Fine-grained AI edit permissions](imgs/screenshots/ai-permission-rules.png)

</details>

<details>
<summary><strong>🏗️ Architecture and Isolation Boundaries</strong></summary>

always-accompany runs on a Deno backend and a vanilla Web frontend, organizing its capabilities through Shells, Plugins, Service Generators, and the yonban function layer. UI calls, mode routing, file / tool execution, persistence, and asynchronous results each have a clear entry point.

| Boundary | Current role |
|---|---|
| User | Persistent root boundary for multi-user / server scenarios |
| Character card | Different characters, relationships, clients, or projects use different memory roots, definitions, and conversations |
| Mode | Chat / Code / Work use distinct tables, private directories, preset records, and P1 routes; generic long-term material of the same character card may still be shared |
| Window | Scopes the current turn's input, P1 candidates and results, workspace, and async delivery |

</details>

<details>
<summary><strong>🔭 On 1M, 2M, and Larger Context Windows</strong></summary>

Larger windows are highly valuable, but capacity, attention, cost, and task state are not the same thing. always-accompany does layering and recall mainly to improve attention and optimize how things are stored within the context, especially for today's large code projects and long-term chats.

Perhaps you have run into this: the longer you chat and the more memory accumulates, the more the AI takes in, yet its responses and memory start to blur and slow down; with coding it's this — even given a 1M context, a large project can hit the ceiling right away.

</details>

---

## Roadmap

**Entries and implementations already present in the current repository**: Data + three-layer memory · context management · self-driven P1 / AI P1 · prompt-entry editing and preset switching · mode-specific memory tables · conditional knowledge dynamic injection · Live2D / image desktop companion · screen awareness and game companionship · local voice input · PPT generation · MCP · multiple windows · VS Code extension bridge · Bots for nine platforms · 23 built-in plugin directories · user plugin host · recycle / backup chains · white-box diagnostics · languages and themes.

**Near-term directions**: more Bot platforms · plugin ecosystem and examples · TTS / text-to-image · an AI game engine (deterministic numeric state + LLM narrative + symbolic rendering)

---

## Tech stack

Deno runtime (Node.js compatible) · Express-style routing · vanilla JavaScript / ESM frontend · WebSocket · local JSON / Markdown storage · Electron desktop companion · optional Python services (P1 resources, STT, PPT) · discord.js v14 · VS Code extension bridge.

See [System Architecture](site/wiki/developer/architecture.md) for the architecture, and [YonBan Tools](site/wiki/yonban/tools.md) plus the [Approval System](site/wiki/yonban/approval.md) for the message, tool, and permission chains.

---

## Community

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join_Now-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Share character cards · Publish presets and conditional knowledge · Contribute plugins · Report bugs · Bring real use cases · Join benchmark work · Contribute code.

---

## Technologies and resources used

- **Voice transcription**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (local deployment; the roughly 1.8 GB model is downloaded separately on first use)
- **Word vectors**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Association data**: [SWOW (Small World of Words)](https://smallworldofwords.org/) Chinese association data
- **Tokenization and dictionaries**: THUOCL, CoreNatureDictionary, Chinese-Synonyms, and other public resources
- **Search engine bridge**: [ddgs](https://pypi.org/project/ddgs/) (for search requests and result retrieval)

## Acknowledgments

- **[fount](https://github.com/steve02081504/fount)** — an early reference framework for this project, whose ideas on AI message handling, service-source management, and module loading saved substantial low-level development time;
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — a major pioneer of AI roleplay and prompt ecosystems. always-accompany supports importing its community formats including character cards, presets, and worldbooks;
- **The SillyTavern plugin community and every open-source resource author** — thank you for the exploration and sharing on rendering, characters, extensions, retrieval, and toolchains.

## Why this project exists

> The design, architecture, and development of this project were done single-handedly by a job-hunting shut-in (allegedly), with AI-assisted programming, combining algorithm design, biomimicry-inspired ideas, framework architecture, and logical reasoning.

always-accompany was not built to cram trendy features into one menu — at first the author just wanted to use it :). It includes a plugin and framework system plus multiple interface languages; actual coverage varies by plugin and available translation resources.

---

<details>
<summary><strong>📸 More feature screenshots (click to expand)</strong></summary>

| | | |
|---|---|---|
| ![PPT detail](imgs/screenshots/ppt-detail.png) **Full PPT Workflow** | ![Security settings](imgs/screenshots/security-settings.png) **Security & Task Flow** | ![Security center](imgs/screenshots/security-center.png) **Security Center** |
| ![Multi-language](imgs/screenshots/i18n-support.png) **Multi-language Support** | ![CSS themes](imgs/screenshots/css-themes.png) **Multiple Themes** | ![Wiki](imgs/screenshots/wiki-guide.png) **Built-in Wiki** |
| ![Sub-mode](imgs/screenshots/sub-mode-agent.png) **Sub-mode Workflow** | ![Menu](imgs/screenshots/hamburger-menu.png) **Context at a Glance** | ![Loop](imgs/screenshots/auto-loop.png) **Automatic / Scheduled Loop** |
| ![Tool detection](imgs/screenshots/tool-detection.png) **Environment Detection** | ![Memory layers](imgs/screenshots/memory-data-layers.png) **Memory File Structure** | ![Extensions](imgs/screenshots/browser-automation.png) **Browser Automation** |
| ![External interface](imgs/screenshots/external-interface.png) **External Interface** | | |

</details>
