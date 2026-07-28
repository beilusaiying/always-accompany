<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Star%20⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center">English | <a href="README_CN.md">中文</a> | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a></p>

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">Online Wiki (User Guide)</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">P1 Technical Paper</a></p>

> This entire project — design, architecture, and development — was completed independently by a recent university graduate, leveraging AI-assisted programming with skills spanning algorithm design, biomimicry principles, framework architecture, and logical thinking.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# or chmod +x run.sh && ./run.sh   # Linux/macOS
```

Open your browser to `http://localhost:1314` → set up an AI service source → import a character card → start chatting. The Deno runtime downloads itself automatically on first launch, no manual install needed. You'll need at least one AI API key. The app ships with a full built-in wiki walkthrough.

> **Note:** The first launch takes longer than usual — the runtime needs to download dependencies and initialize the database. Please wait for the page to fully load before interacting. Subsequent launches will be much faster.

---

A three-layer recursive memory (day → month → year archiving, pure JSON, 260-year capacity) + a front-loaded retrieval AI (a dedicated AI that only hunts for relevant memories and hands what it finds to the reply AI — each one stays in its own lane) + tiered context cleanup (clearing something just stops it from being sent again; the original text stays put and can always be restored). These three pieces mesh together so the AI keeps remembering every word you've ever said, no longer bound by the context window. On top of that, we've built chat/roleplay, IDE coding mode, work mode (including AI-made slide decks), a Live2D desktop pet (screen awareness + game companion), voice input, a Discord Bot, and MCP external tool integration — every entry point shares the same memory, so switching windows doesn't make the AI forget you. Currently being refined: a next-generation retrieval engine (a 21-node pure-algorithm pipeline, zero LLM, zero network, millisecond-level, aiming for sentence-level attention).

---

## Feature Overview

<table>
<tr>
<td width="33%">

**💬 Chat / Roleplay**
![Chat Interface](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE Coding Mode**
![IDE Coding](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Work Mode (AI-made slide decks)**
![Work Mode PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D Desktop Pet + Screen Awareness**
![Desktop Pet](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 L0–L5 Six-Tier Permission Gate**
![Permission Settings](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Tiered Compression × Line-by-Line Control**
![Compression Mechanism](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 Three-layer memory**: hot (injected every turn) / warm (retrieved on demand) / cold (deep archive), pure JSON + purely prompt-driven, zero database
- **🎯 P1 front-loaded retrieval**: a dedicated small AI hunts for memories first and hands them off to the reply AI, BM25 + regex dual engine, retrieval can run on a free model
- **🗜️ Compression system**: three levels (one-click / by type / line-by-line) × four granularities (chat messages / file reads / system injections / process content) + AI-autonomous `<contextClean>` cleanup, everything is reversible
- **📊 10 memory tables**: structured storage, auto-maintained by the AI via `<tableEdit>`, achieving information isolation (if the character wouldn't know something, it's simply not in the table)
- **👑 Prompt engine**: 5-segment message structure + TweakPrompt three-round takeover, macro variables + world book dynamic injection (always-on / regex / dynamic modes)
- **💻 IDE-level workflow**: VSCode-style three-panel layout, AI reads and writes files directly, command execution approved line by line
- **🔌 MCP external tools**: paste a JSON snippet to connect; command-type servers are blocked by default until the owner approves, with an env-variable allowlist to prevent leaks
- **🐾 Desktop pet + game companion**: Live2D / image-pack pet, three privacy tiers, auto-screenshotting + chiming in on its own + adaptive frequency
- **🎙️ Voice input**: local model transcription, speaker separation + timeline, audio never leaves the machine
- **🤖 Cross-platform Bot**: Discord deployment, visual management + real-time message log
- **🧩 22 feature plugins** + user-level plugin host + ecosystem compatibility (import character cards/presets/world books in multiple formats)
- **🛡️ All data stays local**: deletions go to a recycle bin and can be recovered, multi-layer auto-backup + git rollback
- **🌐 Multi-language** (Chinese/English/Japanese/Traditional Chinese) · **🔬 Full-stack diagnostics** (12-module logs + one-click packaging) · **🎨 Multiple CSS themes**

---

## Detailed Mechanisms

<details>
<summary><strong>🧠 Three-Layer Recursive Memory — Why Layer It At All</strong></summary>

Dumping the entire history into one big pool makes lookups slow — and the experimental data backs this up ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)): even if it's in there, the model may not actually see it. Modeled on how the hippocampus forms memories and on the Ebbinghaus forgetting curve, we split information into three layers by time distance:

```
🔥 Hot layer — auto-injected every turn: user profile / permanent memories / pending tasks / recent memories
🌤️ Warm layer — retrieved on demand (last month): daily summaries / temporary archives / monthly index
❄️ Cold layer — deep retrieval (older than a month): monthly summaries / historical daily summaries / yearly index
```

The hot layer costs only ~7,000–11,000 tokens per turn (5–9% of a 128K window). Memory decay borrows from the Ebbinghaus forgetting curve: `score = weight × (1 / (1 + days × 0.1))`. Purely prompt-driven — change the archival strategy, table meanings, or retrieval style just by editing the prompt, no code changes needed.

</details>

<details>
<summary><strong>🎯 P1 Front-Loaded Retrieval AI — Why Split Into Two AIs</strong></summary>

If the reply AI has to pick the relevant bits out of hundreds of history entries itself, it's both hunting and replying at once, and its attention gets diluted between the two jobs. So we split "finding memories" out into a dedicated small AI:

```
User sends a message → P1 retrieval AI (<5K tokens, focused purely on recall) → selected memories + current chat → reply AI (focused purely on replying)
```

BM25 coarse filtering + regex exact matching, hits the target in at most 3 rounds. Retrieval runs fine on a free lightweight model, so the actual per-conversation cost is essentially just one reply-AI call. P1 also handles automatic preset switching (with a 5-turn cooldown to prevent oscillation).

</details>

<details>
<summary><strong>🗜️ Context Management — Compression Granularity × Levels × AI-Autonomous Cleanup</strong></summary>

While the AI works, process content keeps piling up (re-reading the same file, stale search results, old tool outputs). Our cleanup only ever hides things — everything can be restored at any time.

**AI-autonomous cleanup**: the system feeds the AI signals about its own context usage (50% suggested / 70% warning / 85% urgent), and the AI uses `<contextClean>` commands to trim itself autonomously. It writes things down before clearing, so a bad call is still reversible.

**Fine-grained user control**: three levels (one-click full cleanup / by type / hand-picking line by line) × four granularities (chat messages / per-item file-read token billing / five checkable categories of system injections / auto-trimmed process content).

Measured cache hit rate (Opus + DeepSeek, including AI persona switching + autonomous compression): **75%–80%**.

![Compression Panel](imgs/screenshots/compression-multi.png)

</details>

<details>
<summary><strong>🔬 Self-Driven P1 — A Zero-LLM Retrieval Engine In Active Development</strong></summary>

The P1 AI has to fire off an API request every turn — that means latency, cost, and no offline use. We've been building a fully algorithmic pipeline (21 nodes, ~9,000 lines) aimed at millisecond-level speed, zero network dependency, and sentence-level attention.

**Data foundation**: the [SWOW Chinese association network](https://smallworldofwords.org/) / [ConceptNet Numberbatch 300-dimensional word vectors](https://github.com/commonsense/conceptnet-numberbatch) (~300,000 words) / ConceptNet's Chinese relation graph / THUOCL and other multi-source dictionaries. The lexicon was assembled via AI web search + 2 days of self-review, at close to zero build cost.

**Pipeline**: tokenization → SWOW associative divergence (synonym diffusion is banned — enabling it measurably drops quality by 55–76%) → six-axis parallel scoring (psychological / informational / social / logical / linguistic / cognitive) → 47 sub-direction localization → multi-resource cross-confirmation → spatial-voting ranking (additive IDW, not multiplicative) → secondary divergence (5 independent paths) → BLQ scoring (referencing CombSUM additive fusion, with self-researched dimension weights) → direction-word selection → context injection. All 21 nodes are pure algorithm, zero LLM.

**Experiments**: 27 version iterations; the divergence score went from 2.01 to 4.05 between v9 and v26 (+101%, out of 5, judged word-by-word by hand); recall hit rate ~90%; overall average score ~3.5. The generic/catch-all rate dropped from 74% to 4%.

**Real output** (raw records from a 200-case batch run):

| User Input | System's Divergent Direction | Discipline Crossed Into |
| --- | --- | --- |
| "I can barely hold on anymore, why is being alive so hard?" | Present-moment awareness / interoceptive awareness / **what is the nature of the real** | Psychology → **existentialist philosophy** |
| "Prepping for a unicorn-company interview, how do I come up with questions with real depth?" | Root cause analysis / **zone of proximal development** | Management → **educational psychology** |
| "Win back churned users in owned-traffic operations on a limited budget" | **Default mode network activation** / **BDNF (brain-derived neurotrophic factor)** | Marketing → **cognitive neuroscience** |
| "Database queries are painfully slow, how do I optimize them" | Immutability and state updates / **SRP (Single Responsibility Principle)** | Ops → **software engineering methodology** |
| "A story about a swordsman meeting an enemy on a snowy mountain" | **Chekhov's gun** / Jungian archetypes | Fiction → **narratology + analytical psychology** |
| A user's original poem, "I died before the light arrived" | **Possible worlds and parallel universes** | Poetry → **many-worlds interpretation in physics** |

Lexicon admission standard: **any word the primary model could already infer just by reading the raw input is a wasted word** — P1's value lies in giving the model directions it wouldn't come up with on its own.

</details>

<details>
<summary><strong>👑 Prompt Engine + World Book Dynamic Injection</strong></summary>

**TweakPrompt's three rounds** take over every module's output in a unified way: Round 1 collects → Round 2 rebuilds the 5-segment message structure (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + macro substitution → Round 3 snapshots.

**World book has 3 activation modes**: always-on (injected every turn) / regex (keyword-triggered) / dynamic (triggered by reading numeric conditions from memory tables — e.g. affection > 80 unlocks a special dialogue, or quest progress reaching chapter 3 swaps in a different worldview description).

**Macro system**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + custom macros.

</details>

<details>
<summary><strong>🏗️ System Architecture</strong></summary>

Three layers: **function layer** (memory / compression / recall / presets / world book / networking / file operations… a single global copy) → **transport layer** (each window pulls its own line, isolated by id, naturally async and non-blocking) → **interface layer** (web / Bot / desktop pet / VSCode extension — swap the interface without losing any capability).

Data isolation: user-level (AI sources / global settings) / character-card-level (memory / chat / world book / regex) / conversation-level (chat history / mode / sub-mode).

22 plugins all grow under one unified spec, MCP connects external tools, and the user-level plugin host mounts Python/Node programs — extensions never touch the core codebase.

</details>

<details>
<summary><strong>🔭 On the Era of Giant Context Windows</strong></summary>

Even if context windows expand to 10M+ tokens, we still keep layered memory: ① there's solid experimental evidence that context utilization decays as length grows; ② ~10K tokens of curated memory carries the information of 100K+ tokens of raw history, at an order-of-magnitude lower cost; ③ structured tables are easier for an AI to read and write accurately than information scattered across a conversation.

</details>

---

## Roadmap

**Completed**: three-layer memory · compression system · P1 retrieval · prompt engine · automatic preset switching · memory tables · world book dynamic injection · Live2D desktop pet · game companion · voice input · AI-made slide decks · MCP · multi-window parallelism · VSCode extension bridge · Discord Bot · 22 plugins · recycle bin & backup rollback · full-stack diagnostics · multi-language support

**Near-term plans**: self-driven P1 (pure algorithm, zero LLM, sentence-level attention) · more Bot platforms · plugin ecosystem · TTS / text-to-image · AI game engine (in the "era" game lineage — deterministic code for numeric state + LLM narrative + symbolic rendering) · live-streaming mode

---

## Tech Stack

Runtime fount (Deno) · Backend Node.js compatibility layer + Express-style routing · Frontend vanilla JS (ESM) · Smart retrieval BM25 + regex (pure JS, zero dependencies) · Desktop pet Electron · Voice local transcription model · Cross-platform discord.js v14 · Storage pure JSON

---

## Community

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join%20Now-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Share character cards · Publish presets · Contribute world books · Report bugs · Suggest features · Contribute code — all welcome!

---

## Technologies & Resources Used

- **Voice transcription**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (local deployment with speaker diarization; the model, ~1.8GB, downloads automatically on first use)
- **Word vectors**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Association data**: the [SWOW (Small World of Words)](https://smallworldofwords.org/) Chinese association dataset
- **Tokenization & dictionaries**: THUOCL / CoreNatureDictionary / Chinese-Synonyms and other public resources
- **Search engine bridge**: [ddgs](https://pypi.org/project/ddgs/) (a Python TLS-fingerprint layer that solves the problem of raw fetch requests getting downgraded by search engines)

## Acknowledgments

- **[fount](https://github.com/steve02081504/fount)** — the initial reference framework in this project's early days, providing core infrastructure such as AI message handling, service source management, and module loading. The project has since evolved into a fully independent architecture, but fount saved us a lot of low-level development time early on and gave us many valuable ideas to draw from — sincere thanks for that
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — the pioneering project in AI roleplay; its preset format, character card spec, and world book system have become community standards, and this project is fully compatible with its ecosystem
- **SillyTavern plugin community** — thanks to every open-source plugin author for their exploration and sharing around rendering engines, feature extensions, and more

---

<details>
<summary><strong>📸 More Feature Screenshots (click to expand)</strong></summary>

| | | |
|---|---|---|
| ![PPT Detail](imgs/screenshots/ppt-detail.png) **Full PPT Workflow** | ![Security Settings](imgs/screenshots/security-settings.png) **Security & Task Flow** | ![Security Center](imgs/screenshots/security-center.png) **Security Center** |
| ![Multi-language](imgs/screenshots/i18n-support.png) **Multi-language Support** | ![CSS Themes](imgs/screenshots/css-themes.png) **Multiple Themes** | ![Wiki](imgs/screenshots/wiki-guide.png) **Built-in Wiki** |
| ![Sub-mode](imgs/screenshots/sub-mode-agent.png) **Sub-mode Workflow** | ![Menu](imgs/screenshots/hamburger-menu.png) **Context at a Glance** | ![Loop](imgs/screenshots/auto-loop.png) **Auto/Scheduled Loop** |
| ![Tool Detection](imgs/screenshots/tool-detection.png) **Environment Detection** | ![Memory Layers](imgs/screenshots/memory-data-layers.png) **Memory File Structure** | ![Extensions](imgs/screenshots/browser-automation.png) **Browser Automation** |
| ![External Interface](imgs/screenshots/external-interface.png) **External Interface** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>

