# always accompany

### beilu

> **Make AI truly remember.**

always accompany is an **AI companion platform unifying companionship and productivity**, combining an **IDE editing environment**, a **multi-AI collaboration engine**, an **original layered memory algorithm**, and a **chat system compatible with the SillyTavern ecosystem**. It addresses the two fundamental bottlenecks of current LLMs head-on: **limited context windows** and **attention degradation as context grows**.

English | [中文](README_CN.md)

> This entire project — design, architecture, and development — was completed independently by a university student, leveraging AI-assisted programming with skills spanning algorithm design, biomimicry principles, framework architecture, and logical thinking.

### 💬 Join the Community

[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/agHeDq9bqU)

Get dedicated prompts (Chat AI, Memory AI, etc.), build the community together, and have fun!

<p align="center">
  <img src="imgs/screenshots/chat-ide.png" alt="Chat & IDE Interface" width="800">
</p>

<p align="center"><em>Chat interface with IDE-style file editor — fine-tuned rendering, beautification support, adjustable chat width</em></p>

---

## Why This Project?

### The Fundamental Problem with Current AI

Whether it's AI coding tools (Cursor, Copilot), AI chat applications (ChatGPT, Claude), or AI roleplay platforms (SillyTavern), they all face the same underlying limitations:

| Problem                    | Current State                                                      | Consequence                                                 |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| **Limited context window** | Even 128K-1M tokens overflow in long conversations                 | Early messages get truncated; AI loses critical information |
| **Attention degradation**  | The longer the context, the less the model focuses on each segment | Even if information exists in context, AI may "overlook" it |
| **No persistent memory**   | Closing a conversation = forgetting everything                     | Every new session starts from zero                          |

### Our Solution

**Don't stuff all memories into the context. Let a dedicated AI retrieve them on demand.**

```
Traditional:  [All historical memory + current chat] → Single AI → Attention scattered
                              ↓
Our approach: [Index] → Retrieval AI (focused on finding) → [Selected memory + current chat] → Reply AI (focused on quality)
```

The Reply AI only sees **precisely filtered memory fragments** from the Retrieval AI. The context is clean, the signal-to-noise ratio is extremely high, and attention **never degrades**.

---

## Core Features

### 🧠 Original Layered Memory Algorithm

Designed after the human hippocampus memory formation mechanism and the Ebbinghaus forgetting curve, achieving **theoretically unlimited AI memory**.

#### Three-Layer Memory Architecture

```
🔥 Hot Memory Layer — Injected every turn
   User profile / Permanent memories Top-100 / Pending tasks / Recent memories about user

🌤️ Warm Memory Layer — On-demand retrieval, last 30 days
   Daily summaries / Archived temporary memories / Monthly index

❄️ Cold Memory Layer — Deep retrieval, beyond 30 days
   Monthly summaries / Historical daily summaries / Yearly index
```

Additionally, an **L0 Memory Table Layer** (10 customizable tables, fully injected every turn as CSV) provides structured immediate context.

#### Key Metrics

| Metric                               | Value                                                                 |
| ------------------------------------ | --------------------------------------------------------------------- |
| Hot layer injection per turn         | **~7,000-11,000 tokens** (only 5-9% of a 128K window)                 |
| Retrieval AI context                 | **<5,000 tokens** (100% attention focused on retrieval)               |
| Storage cost                         | **Zero** (pure JSON files, no database dependency)                    |
| Single-character sustained operation | **12+ years** (at 5,000 files)                                        |
| Theoretical duration                 | **260+ years** (at 100,000 files; NTFS/ext4 support far exceeds this) |

#### Memory Decay Formula

```
score = weight × (1 / (1 + days_since_triggered × 0.1))
```

Inspired by the Ebbinghaus forgetting curve: important and recently triggered memories are prioritized for injection, rather than simple chronological order.

#### Pure Prompt-Driven — Zero Hardcoded Limitations

The most critical design feature of the memory system: **all memory injection, retrieval, archival, and summarization operations are performed by AI through prompts**, not traditional hardcoded logic.

This means:

- **Table meanings and purposes can be changed anytime**: Simply modify the prompt descriptions for tables, and the AI will interpret and operate them accordingly — no code changes needed
- **Archival strategies are instantly adjustable**: P2-P6 behaviors are entirely defined by prompts; modifying prompts changes archival rules, summary formats, and retrieval strategies
- **Zero technical barrier for migration**: Users can edit prompts themselves to adapt to different scenarios (roleplay / coding assistant / game NPC) without programming skills
- **Naturally avoids technical debt**: No complex parsers or state machines to maintain — the AI itself is the most flexible "parser"

### 🤖 Multi-AI Collaboration Engine

The system has **7 built-in AI roles**, each with a dedicated responsibility:

| AI                    | Role                                                                       | Trigger              |
| --------------------- | -------------------------------------------------------------------------- | -------------------- |
| Chat AI               | Conversation with users, file operations                                   | User sends a message |
| P1 Retrieval AI       | Search relevant history from memory layers (up to 5 rounds of deep search) | Automatic per turn   |
| P2 Archive AI         | Summarize and archive when temporary memories exceed threshold             | Automatic            |
| P3 Daily Summary AI   | Generate detailed daily summary                                            | Manual               |
| P4 Hot→Warm AI        | Move expired hot-layer memories to warm layer                              | Manual               |
| P5 Monthly Summary AI | Warm→Cold archival, generate monthly summaries                             | Auto/Manual          |
| P6 Repair AI          | Check and fix memory file format issues                                    | Manual               |

Retrieval AI is recommended to use **Gemini 2.0/2.5 Flash** (fast, low cost). Reply AI can use any model of your choice.

### 🖥️ IDE-Style Interface

VSCode-style three-panel layout:

- **Left panel**: Preset management / World book binding / Persona selection / Character editing
- **Center panel**: Chat / File editor / Memory management — three-tab switching
- **Right panel**: Character info / Feature toggles / Memory AI operation panel

### 🔌 11 Feature Plugins

Preset engine / Memory system / File operations / Desktop screenshot / Logger / Feature toggles / Multi-AI collaboration / Regex beautification / World book / Web search / System info

### 🌐 Multi-Language Support (i18n)

The management home page (beilu-home) supports 4 languages via a "translation overlay" approach — no restructuring of existing code, just adding `data-i18n` attributes to DOM elements for automatic translation.

| Code  | Language                       |
| ----- | ------------------------------ |
| zh-CN | Simplified Chinese (default)   |
| en-UK | English                        |
| ja-JP | 日本語 (Japanese)              |
| zh-TW | 繁體中文 (Traditional Chinese) |

- Language preference auto-saved to `localStorage`, persists across refreshes
- Dynamic content (JS-generated text) translated via `t(key)` function
- Language switch triggers a `beilu-lang-change` event; all modules respond automatically

### 📦 SillyTavern Ecosystem Compatible

- Direct import of SillyTavern format character cards, presets, and world books
- Support for Risu formats (ccv3 / charx / rpack)
- 14 AI service generators (proxy / gemini / claude / ollama / grok, etc.)

---

## Comparison with Existing Tools

### vs AI Chat Applications (ChatGPT / Claude / Gemini)

| Dimension      | ChatGPT etc.                            | always accompany                                                 |
| -------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Memory         | Simple summaries / conversation history | Three-layer graded + multi-AI retrieval, theoretically unlimited |
| Attention      | Degrades as context grows               | Retrieval AI pre-filters; Reply AI attention stays focused       |
| Customization  | Limited System Prompt                   | Full preset system + 10 customizable memory tables               |
| Data ownership | Server-side storage                     | Local JSON files, fully self-owned                               |

### vs AI Coding Tools (Cursor / Copilot / Windsurf)

| Dimension              | Cursor etc.                     | always accompany                                                                                   |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| Project memory         | Based on current file context   | Cross-session persistent memory (architecture decisions, code conventions, historical discussions) |
| Multi-AI collaboration | Single model                    | 7 AIs with dedicated roles; retrieval/summary/reply separated                                      |
| Memory cost            | Relies on large context windows | ~10K tokens covers the hot layer                                                                   |

### vs AI Roleplay Platforms (SillyTavern)

| Dimension            | SillyTavern               | always accompany                                             |
| -------------------- | ------------------------- | ------------------------------------------------------------ |
| Memory               | No built-in memory system | Original three-layer memory + 6 auxiliary AIs                |
| File operations      | None                      | Built-in IDE file management + AI file operations            |
| Desktop capability   | None                      | beilu-eye desktop screenshot → AI recognition                |
| Preset compatibility | Native                    | Fully compatible with ST presets/character cards/world books |

---

## Thoughts on the Future of LLMs

Even when context windows expand to **10M+ tokens**, layered memory remains valuable:

1. **Attention problems won't disappear**: No matter how large the window, model attention on massive text will still degrade. Pre-filtering + precise injection will always outperform "stuff everything in."
2. **Cost efficiency**: Larger windows = higher costs. Replacing 100K+ tokens of full history with ~10K tokens of selected memory reduces API call costs by **10x or more**.
3. **Structured > Unstructured**: Tabular memory is easier for AI to accurately read and update than information scattered across conversations.

Layered memory is not a temporary workaround for limited context windows — it is a **superior paradigm for information organization**.

---

## Roadmap

### ✅ Completed

- Original three-layer memory algorithm (pure prompt-driven)
- Multi-AI collaboration engine (Memory AI + Reply AI)
- IDE-style interface with file operations
- Desktop screenshot system (beilu-eye)
- Rendering engine (JS-Slash-Runner level)
- Memory table enhancement
- Management home page i18n (Chinese / English / Japanese / Traditional Chinese)
- 11 feature plugins

### 🔜 Near-term

- APT entry switching enhancement
- Vector DB / RAG semantic retrieval
- Embedding API (OpenAI)

### 🔮 Long-term Vision

- **Cross-platform Bot integration** (Discord, etc.)
- **Plugin ecosystem** (Workshop-style high extensibility)
- **Live2D integration** + AI-controlled models
- **AI game engine** (chat interface = game interface, code-compatible, userscript-friendly)
- **TTS / Text-to-image** integration
- **VSCode extension compatibility**
- Highly extensible core architecture

---

## Getting Started

### Requirements

- [Deno](https://deno.land/) runtime
- Modern browser (Chrome / Edge / Firefox)
- At least one AI API key (Gemini API recommended — free tier available)

### Installation & Launch

```bash
# Clone the project
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany

# Launch (Windows)
run.bat

# Launch (Linux/macOS)
chmod +x run.sh
./run.sh
```

After launch, open your browser and navigate to `http://localhost:1314`

### Basic Configuration

1. **Configure AI source**: Home → System Settings → Add AI service source (proxy / gemini, etc.)
2. **Import character card**: Home → Usage → Import (supports SillyTavern PNG/JSON format)
3. **Configure memory presets**: Home → Memory Presets → Set up API for P1-P6 (Gemini 2.0 Flash recommended)
4. **Start chatting**: Click a character card to enter the chat interface

### Using the Memory System

- **Automatic operation**: Memory tables are automatically maintained by the Chat AI (via `<tableEdit>` tags); Retrieval AI (P1) triggers automatically each turn
- **Manual operations**: Chat interface right panel → Memory AI Operations → P2-P6 manual buttons
- **Daily archival**: At the end of each day, click the "End Today" button to trigger the 9-step daily archival process
- **Memory browsing**: Chat interface → Memory Tab → Browse/edit/import/export memory files

---

## Tech Stack

| Component          | Technology                                          |
| ------------------ | --------------------------------------------------- |
| Runtime            | Fount (based on Deno)                               |
| Backend            | Node.js compatibility layer + Express-style routing |
| Frontend           | Vanilla JavaScript (ESM modules)                    |
| AI integration     | 14 ServiceGenerators                                |
| Desktop screenshot | Python (mss + tkinter + pystray)                    |
| Storage            | Pure JSON file system                               |

---

## Acknowledgments

This project would not be possible without the contributions of the following open-source projects and communities:

- **[Fount](https://github.com/steve02081504/fount)** — The foundational framework providing AI message handling, service source management, module loading, and other core infrastructure, saving significant development time on low-level implementation
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — The pioneering project in AI roleplay, whose preset format, character card specification, and world book system have become community standards. This project is fully compatible with its ecosystem
- **SillyTavern Plugin Community** — Thanks to all open-source plugin authors for their exploration and sharing. Their work on rendering engines, memory enhancement, and feature extensions provided valuable references and inspiration for this project's design

---

## Screenshots

<details>
<summary><strong>📁 IDE File Editor — AI-powered file operations with safety controls</strong></summary>

AI file capabilities: 📖 Read / ✏️ Write / 🗑️ Delete / 🔄 Retry / 🔌 MCP / ❓ Questions / 📋 Todo

You can disable write and delete permissions for safety. For beginners unfamiliar with AI coding, we recommend using the designated sandbox space.

![File Editor](imgs/screenshots/file-editor.png)

</details>

<details>
<summary><strong>🧠 Memory File Browser — View and edit memory data in real-time</strong></summary>

Browse the three-layer memory structure (hot/warm/cold), manually edit content anytime, and observe memory AI operations. You can also make requests to the memory AI directly.

![Memory Browser](imgs/screenshots/memory-browser.png)

</details>

<details>
<summary><strong>🎨 Regex Script Editor — Sandbox & Free modes for beautification</strong></summary>

Manage regex rules at global, character, and preset levels. Sandbox mode protects against potentially malicious scripts from unknown character cards.

> ⚠️ We cannot guarantee complete safety against all malicious scripts. Always review character card code before use. We are not responsible for any damages.

![Regex Editor](imgs/screenshots/regex-editor.png)

</details>

<details>
<summary><strong>📋 Preset Manager — Commander-level prompt control</strong></summary>

Full control over all sent content at the commander level, maximizing prompt effectiveness. Drag-and-drop ordering, enable/disable toggles, and role assignment for each entry.

![Preset Manager](imgs/screenshots/preset-manager.png)

</details>

<details>
<summary><strong>📊 Memory Table Editor — 10 customizable structured tables</strong></summary>

Tables #0-#9 with configurable columns, insert/update/delete rules. Set P2 archive threshold for automatic compression. All table meanings are defined by prompts — zero hardcoded limitations.

![Memory Tables](imgs/screenshots/memory-tables.png)

</details>

<details>
<summary><strong>🧠 Memory Presets P1-P6 — Fully prompt-driven, zero technical barrier</strong></summary>

Configure each memory AI's behavior, trigger mode, and API settings. P2-P6 behaviors can all be modified through prompts — no coding required, highly adaptable.

![Memory Presets](imgs/screenshots/memory-presets.png)

</details>

<details>
<summary><strong>📖 System Viewer — Detailed documentation for quick onboarding</strong></summary>

Built-in documentation covering macros, memory system, preset engine, world books, plugin system, and more. Get up to speed quickly without external guides.

![System Viewer](imgs/screenshots/system-viewer.png)

</details>

<details>
<summary><strong>📦 SillyTavern Compatible — Import/export works seamlessly</strong></summary>

Character cards, world books, personas, chat presets — import and export with full compatibility. It feels just like home for SillyTavern users.

![ST Compatible](imgs/screenshots/st-compatible.png)

</details>

<details>
<summary><strong>🔬 AI Diagnostics — Complete system self-diagnosis</strong></summary>

Real-time system status, P1 auto-trigger state, cache inspection, injection logs, and memory AI run logs. Faster feedback for troubleshooting errors and issues.

![AI Diagnostics](imgs/screenshots/ai-diagnostics.png)

</details>

---

## License

This project is built on the [Fount](https://github.com/steve02081504/fount) framework, with direct authorization from the original author.
