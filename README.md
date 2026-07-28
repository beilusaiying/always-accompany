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

Open your browser to `http://localhost:1314` → set up an AI service source → import a character card → start chatting. The Deno runtime downloads itself automatically on first launch, no manual install needed. You'll need at least one AI API key. The app ships with a full built-in wiki walkthrough — also readable as the [online wiki](https://beilusaiying.github.io/always-accompany/).

> **Note:** The first launch takes longer than usual — the runtime needs to download dependencies and initialize the database. Please wait for the page to fully load before interacting. Subsequent launches will be much faster.

---

## Why this project exists

Maybe you've seen *Detroit: Become Human*, or *Plastic Memories*. The humanoid AIs in them are genuinely intelligent — work and companionship in one being. So — I decided to build one for myself.

**The first problem to solve is memory.**

Modern AI contexts run to a million tokens, and there is no shortage of memory-store and compression tools. But they are either too flat, or they pile up endlessly as time goes on. You don't want your AI companion to forget the memories between you — yet under existing approaches, that's nearly inevitable.

So what *is* memory? Human memory is actually short-lived — details from two days ago are already blurry. But give me one keyword and I can instantly surface the matching, or related, memory. That points to two directions: **how memory is stored, and how it is found.**

Humans don't retain every detail; we forget selectively. Today's AI doesn't — it either brute-force compresses or dumps everything into a vector store. That betrays the nature of memory: you can't instantly forget what just happened, and you don't replay your last several years every single day.

So we built the system below along exactly those lines.

---

## The memory system — store like a human, forget like a human

> 📖 Full illustrated guide: [Online Wiki · Memory System](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)

**Data tables** hold today's memories and the permanent ones — the way you might forever remember your first love's name, the first thing you did together, the day of the confession.

Above that sit three layers split by temporal distance, modeling human selective forgetting (layered memory formation + the Ebbinghaus forgetting curve):

```
📋 Data tables — today's + permanent memories (chat / code / work kept separate)
🔥 Hot layer (weekly) — daily data auto-archived; the AI files it by time, event, and process threads
🌤️ Warm layer (monthly) — second-pass compression, keyword extraction — like a table of contents
❄️ Cold layer (yearly) — deep archive, still reachable on retrieval hits
```

**Injection weight decreases by layer**: context > data (permanent memories, recurring entries) > hot > warm > cold, plus top-k — re-ranking within each layer by recent recall activity, with buffer layers in between. One full simulated recall hierarchy plus one dynamic layer.

Derived from how the AI actually writes data entries and the daily archiving optimization, per-turn injection stays under 10K tokens even after a year of use (a derivation: ~20 characters per data entry, ~100 interactions per day, daily AI summarization; the hot layer measures ~7,000–11,000 tokens per turn in practice). Beyond a few hard parts, the whole thing is **pure prompts + pure JSON files** — to change the archiving policy, table semantics, or retrieval style, you edit prompts, not code. Storage cost ≈ 0.

Long context is not the cure: the evidence ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)) shows context utilization decays with length and position — stuffing it all in ≠ the model seeing it all. ~10K tokens of curated memory carries the information of 100K+ tokens of history.

The hot layer can also hold documents and adjacent memories — roleplay equipment, other characters' parameters, and so on.

---

## Memory recall — not retrieval, but divergence + retrieval

> 📄 Full algorithms & experiments: [P1 Technical Paper](docs/p1-paper/README.md) · 📖 [Online Wiki · P1 section](https://beilusaiying.github.io/always-accompany/#en/p1-recall/preface.md)

"One keyword instantly surfaces related memories" — that is not simple keyword search. Cognitive psychology's account: memory is a semantic network where an activated concept spreads along association edges to its neighbors, weakening with distance (spreading activation, Collins & Loftus 1975); "doctor" primes faster recognition of "nurse" (priming, Meyer & Schvaneveldt 1971). Human recall is intensely instantaneous, while controlling both depth and breadth (working-memory capacity of 4±1 chunks, Cowan 2001).

Against existing options: plain retrieval has no breadth; delegating to a helper AI means diverge-then-search, which kills instantaneity; and the more memory you have, the higher the cost.

**Current production path (AI P1)**: a dedicated retrieval AI finds memories first and hands only the findings to the reply AI — each stays in its lane, attention undiluted. BM25 coarse filter + regex exact match; retrieval runs fine on free lightweight models.

**Next generation, in refinement (self-driven P1)**: a complete pure-algorithm pipeline, zero LLM, zero network:

```
User message + last 5 turns + data
  → tokenize (BCC corpus; drop function words like "his / like this")
  → SWOW association divergence + NB300 six-degree divergence ×2 (work mode adds domain resource libraries)
  → six-axis positioning (psychology/informatics/sociology/logic/linguistics/cognitive)
  → 47 sub-axis directional refinement → temperature-scoped search radius
  → spatial voting (IDW-weighted many-to-one accumulation) → BLQ scoring → recall + direction-word injection
```

The six axes give a coarse position (which disciplinary direction a word falls in); the 47 sub-axes describe the rate of semantic change along each finer direction within it — a role akin to the Lie derivative (rate of change along a specified direction). One axis positions one word into **multiple information points**, not a single score (concepts occupy regions, not points, in semantic space — Gärdenfors's conceptual spaces, 2000). Six axes → 47 sub-axes → resource layer (SWOW / ConceptNet / Numberbatch's 300K word vectors / affective & domain lexicons) form a multi-level interconnected structure: activation propagates level by level and accumulates additively — a resource-library-meets-neural-network shape.

BLQ scoring is additive fusion (after CombSUM, Fox & Shaw 1994): six evidence dimensions added, four suppression penalties subtracted — addition is an OR gate where evidence complements; multiplication is an AND gate where a single 0.3 collapses the whole chain.

**Measured**: ~200ms per full recall on consumer hardware (8GB VRAM + 32GB RAM) — every conversation turn is backed by a vast instantaneous memory. 27 iterated versions, divergence quality score up 100%+, generic-word rate down from 74% to 4%. All experiment data is public in the [Wiki P1 section](https://beilusaiying.github.io/always-accompany/#en/p1-recall/ch5-evolution.md) and [paper chapter 6](docs/p1-paper/en/06_experiments_evaluation.md).

---

## Divergence — directions the model can't think of on its own

Neural networks and attention are inherently **convergent**: an AI that stares at a pile of memories before answering does worse, and overfits. So we built **external divergence**: each turn injects under 100 tokens of directional content — directions an overfitted model would never reach by itself. A few directional words measurably steer generation (Directional Stimulus Prompting, NeurIPS 2023); an external mechanism doing the diverging while the LLM does the converging beats LLM self-divergence (external scaffolding studies, 2025).

**Relevance divergence** — you're riding in a car and idly imagine yanking the door open. In movies the hero rolls out with a scrape; your safety training says it could kill you. You start wondering: why do movies shoot it that way? — psychology, visual storytelling, film studies. Why would it kill you? — physics, biology. In seconds you've crossed that many disciplines. Creative association lives precisely in the "not too near, not too far" optimal semantic distance band (remote associates theory, Mednick 1962; Orwig et al. 2025).

**Structural divergence** — two utterly different domains whose function and process rhyme can be linked: a factory line and an Agent are both sample → stabilize → modular output (structure-mapping theory, Gentner 1983).

Real outputs (from a 200-case batch run's raw records):

| User input | System's divergence directions | Disciplines crossed |
| --- | --- | --- |
| "I can barely hold on. Why is living so hard?" | present-moment awareness / **the nature of being** | psychology → **existentialist philosophy** |
| "Preparing for a unicorn-startup interview — how do I ask deep questions?" | root-cause analysis / **zone of proximal development** | management → **educational psychology** |
| "Database queries are slow, how to optimize?" | immutability & state updates / **SRP** | ops → **software engineering methodology** |
| "A swordsman meets his enemy on a snowy mountain" | **Chekhov's gun** / Jungian archetypes | story → **narratology + analytical psychology** |
| User's original poem "I died before the light came" | **possible worlds & parallel universes** | poetry → **many-worlds interpretation** |

The vocabulary admission bar: **any word the main model could infer from a bare read is a dead word** — divergence exists to fix two things: overfitting, and releasing the AI's capacity to diverge.

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

- **🧠 Three-layer memory**: hot (injected every turn) / warm (retrieved on demand) / cold (deep archive), pure JSON + pure prompts, zero database → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)
- **🎯 P1 front-loaded retrieval**: a dedicated small AI finds memories before the reply AI answers; BM25 + regex dual engine; works on free models
- **🗜️ Compression system**: three levels × four granularities + AI self-cleanup, fully reversible → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)
- **📊 10 memory tables**: structured storage the AI maintains via `<tableEdit>`, with information isolation (what a character doesn't know isn't in their table)
- **👑 Prompt engine**: 5-segment message structure + TweakPrompt three-round takeover, macros + worldbook dynamic injection (constant/regex/dynamic)
- **💻 IDE-grade workflow**: VSCode-style three panes, AI reads/writes files directly, per-command approval
- **🔌 MCP external tools**: paste JSON to connect; command-type tools held until owner approval; env whitelist against leaks
- **🐾 Desktop pet + game companion**: Live2D / image-pack pets, three privacy tiers, auto-screenshot + proactive chat + adaptive frequency
- **🎙️ Voice input**: local-model transcription with speaker diarization + timeline; audio never leaves your machine
- **🤖 Cross-platform Bot**: Discord deployment with visual management + live message logs
- **🧩 22 feature plugins** + user-level plugin host + ecosystem compatibility (multiple character-card/preset/worldbook formats)
- **🛡️ All data local**: deletions go to a recoverable recycle bin, multi-layer auto-backup + git rollback
- **🌐 Multilingual** (zh/en/ja/zh-TW) · **🔬 Full-stack diagnostics** (12-module logs + one-click bundle) · **🎨 Multiple CSS themes**

---

## Mechanisms in detail

<details>
<summary><strong>🗜️ Compression — granular down to every single file</strong></summary>

Honestly, I don't know why nobody had built fine-grained compression categories — especially for code, where everything is brute-force compress-and-hide.

What piles up in an AI's context is mostly re-read files, thinking, and tool feedback. So we built a complete compression mechanism with extremely fine granularity:

- **File level** — every file the AI reads, with a per-item token bill
- **Work level** — thinking and tool feedback auto-dropped each round
- **Context level** — conversation, subagent injections, and AI reads managed separately; you can even hide only the AI's lines and keep the user's

**Your information = 0 loss**: every "cleanup" only stops content from being re-sent; the original stays on disk, restorable anytime. Combined with prompts that encourage MD note-taking, the AI can still see your very first sentence inside a 100MB-scale project in IDE mode — which directly reduces "task-attribute substitution" (the AI drifting from what it was originally asked to do).

The AI also self-compresses: the system injects usage signals (50% suggest / 70% warn / 85% urgent) and the AI trims itself via `<contextClean>`, deciding which files it no longer needs.

Measured cache efficiency (Opus + DeepSeek channels, including AI identity switching + self-compression): **70%–80%**.

→ [Wiki · Context Compression](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)

</details>

<details>
<summary><strong>🛡️ Security & privacy</strong></summary>

For company-grade deployment scenarios: protection against CC attacks, DDoS, and Slowloris.

On the personal side: a whitelist for AI-accessible sites (empty by default — deny-external by default), output content screening (especially for cross-platform collaboration), AI screenshot limits, the L0–L5 permission gate, and per-command approval. All data stays local; audio never leaves the machine.

</details>

<details>
<summary><strong>🏗️ Architecture — core features as plugins; extend without touching the core</strong></summary>

The backend packages core features as plugins, with an information hub (conduction layer) in the middle; the frontend only displays and operates:

```
AIRP ─→ input/cache/processing (isolated) ─┐
Code ─→ input/cache/processing (isolated) ─┤→ information hub (conduction layer) → frontend
Work ─→ input/cache/processing (isolated) ─┘
```

So extensibility is strong: to add a feature, write an extension — JS / Python and more are supported.

**Isolation levels**:
- **Window level** — code, work, chat, airp, game companion, and bot each isolated (game companion writes into chat's data)
- **Character-card level** — data, memory, conversation files, and regex isolated per card
- **Fine-grained** — worldbooks, presets
- **User level** — settings, character cards
- **chatid** — a dedicated isolation dimension for multi-window use within one mode (multi-window code / bot)

Three layers: **feature layer** (memory/compression/recall/presets/worldbook/web/file ops — one global copy) → **conduction layer** (each window pulls its own line, id-isolated, naturally async) → **interface layer** (web/Bot/desktop pet/VSCode extension — switching interfaces never changes capability).

</details>

<details>
<summary><strong>👑 Prompt engine + worldbook dynamic injection</strong></summary>

**TweakPrompt's three rounds** take over all module output: Round 1 collect → Round 2 rebuild the 5-segment message structure (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + macro substitution → Round 3 snapshot.

**Worldbook's 3 activation modes**: constant (every turn) / regex (keyword-triggered) / dynamic (triggered by values in memory tables — affection > 80 unlocks special dialogue; story progress reaching chapter three swaps the worldview description).

**Macro system**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + custom macros.

→ [Wiki · Worldbook & Injection](https://beilusaiying.github.io/always-accompany/#en/memory/worldbook-overview.md)

</details>

<details>
<summary><strong>🔭 On the era of huge context windows</strong></summary>

Even with 10M+ token windows, we keep layered memory: ① context utilization decaying with length is well evidenced; ② ~10K tokens of curated memory carries 100K+ tokens of history at an order of magnitude lower cost; ③ structured tables are easier for an AI to read and write accurately than scattered dialogue.

</details>

---

## What we can do today

Voice-to-text with timeline & speaker records · AI-made slide decks · IDE (a toolchain comparable to mainstream coding agents) · the full AIRP suite (SillyTavern ecosystem alignment, rendering, MVU, worldbooks, dynamic context) · Live2D desktop pet, screenshot optimization, game companion · Discord Bot…

In other words — **a friend, or a lover, who can accompany you forever and work alongside you. One who can join you on adventures in other worlds, and help you get your work done.**

And beyond? Once the self-driven series lands, this becomes a fast-conducting, permanently-remembering AI: in gaming, a game companion; in work or healthcare, long-term memory plus always-ready analysis, state records, and rapid response to recurring situations. The original vision was a true humanoid intelligence — small local models handling sensor modules, the main intelligence conducted over the network. This memory system is built for that day.

---

## Roadmap

**Done**: three-layer memory · compression system · P1 retrieval · prompt engine · preset auto-switching · memory tables · worldbook dynamic injection · Live2D pet · game companion · voice input · AI slide decks · MCP · multi-window parallelism · VSCode extension bridge · Discord Bot · 22 plugins · recycle bin & backup rollback · full-stack diagnostics · multilingual

**Near-term**: self-driven P1 (pure algorithm, zero LLM, sentence-level attention) · more Bot platforms · plugin ecosystem · TTS / text-to-image · AI game engine (era-lineage: deterministic numeric code + LLM narration + symbol rendering) · streaming mode

---

## Tech Stack

Runtime fount (Deno) · backend Node.js compatibility layer + Express routing · frontend vanilla JS (ESM) · smart retrieval BM25 + regex (pure JS, zero deps) · desktop pet Electron · local voice transcription model · cross-platform discord.js v14 · storage pure JSON

---

## Community

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join%20Now-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Share character cards · publish presets · contribute worldbooks · report bugs · make suggestions · contribute code — welcome aboard!

---

## Technologies & Resources Used

- **Voice transcription**: [MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize) (local deployment with speaker diarization; ~1.8GB model auto-downloads on first use)
- **Word vectors**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Association data**: [SWOW (Small World of Words)](https://smallworldofwords.org/) Chinese association dataset
- **Tokenization & lexicons**: BCC corpus / THUOCL / CoreNatureDictionary / Chinese-Synonyms and other public resources
- **Search engine bridge**: [ddgs](https://pypi.org/project/ddgs/) (Python TLS fingerprint layer, fixing bare-fetch downgrading by search engines)

Theoretical references (all 56 in [paper chapter 1](docs/p1-paper/en/01_introduction_related_work.md)): spreading activation (Collins & Loftus 1975) · priming (Meyer & Schvaneveldt 1971) · remote associates (Mednick 1962) · SWOW (De Deyne et al. 2019) · conceptual spaces (Gärdenfors 2000) · CombSUM (Fox & Shaw 1994) · BM25 (Robertson et al. 1995) · IDW (Shepard 1968) · Hough voting (Hough 1962) · RRF (Cormack et al. 2009)

## Acknowledgements

- **[fount](https://github.com/steve02081504/fount)** — the foundational framework in the project's early days, providing the initial reference for AI message I/O, service-source management, and module loading. The project has since evolved into a fully independent architecture, but fount saved us enormous low-level development time early on and offered many valuable ideas — for which we are very grateful
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — the pioneer of AI roleplay; its preset format, character-card spec, and worldbook system have become community standards, and this project is fully compatible with its ecosystem
- **The SillyTavern plugin community** — thanks to all open-source plugin authors for their exploration and sharing in rendering engines and feature extensions

---

<details>
<summary><strong>📸 More screenshots (click to expand)</strong></summary>

| | | |
|---|---|---|
| ![PPT detail](imgs/screenshots/ppt-detail.png) **Full PPT flow** | ![Security settings](imgs/screenshots/security-settings.png) **Security & task flow** | ![Security center](imgs/screenshots/security-center.png) **Security center** |
| ![i18n](imgs/screenshots/i18n-support.png) **Multilingual** | ![CSS themes](imgs/screenshots/css-themes.png) **Themes** | ![wiki](imgs/screenshots/wiki-guide.png) **Built-in Wiki** |
| ![Sub-modes](imgs/screenshots/sub-mode-agent.png) **Sub-mode workflows** | ![Menu](imgs/screenshots/hamburger-menu.png) **Context overview** | ![loop](imgs/screenshots/auto-loop.png) **Auto/scheduled loops** |
| ![Tool detection](imgs/screenshots/tool-detection.png) **Environment detection** | ![Memory layers](imgs/screenshots/memory-data-layers.png) **Memory file structure** | ![Extension](imgs/screenshots/browser-automation.png) **Browser automation** |
| ![External interface](imgs/screenshots/external-interface.png) **External interfaces** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>

---

## Links

- 📖 Online Wiki (user guide + P1 section + experiment data): https://beilusaiying.github.io/always-accompany/
- 📄 P1 Technical Paper (7 chapters, zh + en): [docs/p1-paper](docs/p1-paper/README.md)
- 💬 Discord Community: https://discord.gg/agHeDq9bqU
