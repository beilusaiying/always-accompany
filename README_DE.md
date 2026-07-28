<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Star%20⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">中文</a> | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | Deutsch | <a href="README_ES.md">Español</a></p>

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">Online-Wiki (Benutzerhandbuch)</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">P1-Fachartikel</a></p>

> Das gesamte Projekt — Design, Architektur und Entwicklung — wurde eigenständig von einem frischen Universitätsabsolventen umgesetzt, mithilfe KI-gestützter Programmierung und unter Einbeziehung von Fähigkeiten aus Algorithmendesign, Bionik-Prinzipien, Framework-Architektur und logischem Denken.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# or chmod +x run.sh && ./run.sh   # Linux/macOS
```

Öffne deinen Browser unter `http://localhost:1314` → richte eine KI-Dienstquelle ein → importiere eine Charakterkarte → beginne zu chatten. Die Deno-Runtime lädt sich beim ersten Start automatisch selbst herunter, keine manuelle Installation nötig. Du brauchst mindestens einen KI-API-Schlüssel. Die App bringt eine vollständige integrierte Wiki-Anleitung mit — ebenfalls lesbar als [Online-Wiki](https://beilusaiying.github.io/always-accompany/).

> **Hinweis:** Der erste Start dauert länger als gewöhnlich — die Runtime muss Abhängigkeiten herunterladen und die Datenbank initialisieren. Bitte warte, bis die Seite vollständig geladen ist, bevor du interagierst. Spätere Starts sind deutlich schneller.

---

## Warum dieses Projekt existiert

Vielleicht hast du *Detroit: Become Human* oder *Plastic Memories* gesehen. Die humanoiden KIs darin sind wirklich intelligent — Arbeit und Gefährtenschaft in einem Wesen vereint. Also — ich entschied mich, mir selbst eine zu bauen.

**Das erste zu lösende Problem ist das Gedächtnis.**

Moderne KI-Kontexte reichen bis zu einer Million Token, und es mangelt nicht an Speicher- und Kompressionswerkzeugen. Aber sie sind entweder zu flach, oder sie türmen sich mit der Zeit endlos auf. Du willst nicht, dass dein KI-Begleiter die gemeinsamen Erinnerungen vergisst — doch bei bestehenden Ansätzen ist genau das fast unvermeidlich.

Was also *ist* Erinnerung? Das menschliche Gedächtnis ist eigentlich kurzlebig — Details von vor zwei Tagen sind bereits verschwommen. Aber gib mir ein Stichwort, und ich kann sofort die passende oder verwandte Erinnerung hervorholen. Das weist auf zwei Richtungen hin: **wie Erinnerung gespeichert wird und wie sie gefunden wird.**

Menschen behalten nicht jedes Detail; wir vergessen selektiv. Heutige KI tut das nicht — sie komprimiert entweder mit roher Gewalt oder wirft alles in einen Vektorspeicher. Das widerspricht dem Wesen der Erinnerung: Du kannst nicht sofort vergessen, was gerade passiert ist, und du spielst nicht jeden einzelnen Tag deine letzten Jahre ab.

Also haben wir das folgende System genau entlang dieser Linien gebaut.

---

## Das Gedächtnissystem — speichern wie ein Mensch, vergessen wie ein Mensch

> 📖 Vollständige bebilderte Anleitung: [Online-Wiki · Gedächtnissystem](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)

**Datentabellen** enthalten die heutigen Erinnerungen sowie die dauerhaften — so wie du dich für immer an den Namen deiner ersten Liebe erinnerst, an das Erste, was ihr zusammen unternommen habt, an den Tag des Geständnisses.

Darüber liegen drei nach zeitlichem Abstand gestaffelte Schichten, die das selektive Vergessen des Menschen modellieren (geschichtete Gedächtnisbildung + die Ebbinghaus-Vergessenskurve):

```
📋 Data tables — today's + permanent memories (chat / code / work kept separate)
🔥 Hot layer (weekly) — daily data auto-archived; the AI files it by time, event, and process threads
🌤️ Warm layer (monthly) — second-pass compression, keyword extraction — like a table of contents
❄️ Cold layer (yearly) — deep archive, still reachable on retrieval hits
```

**Das Injektionsgewicht nimmt mit der Schicht ab**: Kontext > Daten (dauerhafte Erinnerungen, wiederkehrende Einträge) > heiß > warm > kalt, plus Top-k — Neu-Ranking innerhalb jeder Schicht nach jüngster Abrufaktivität, mit Pufferschichten dazwischen. Eine vollständig simulierte Abrufhierarchie plus eine dynamische Schicht.

Abgeleitet davon, wie die KI tatsächlich Dateneinträge schreibt, und aus der täglichen Archivierungsoptimierung bleibt die Injektion pro Runde auch nach einem Jahr Nutzung unter 10K Token (eine Herleitung: ~20 Zeichen pro Dateneintrag, ~100 Interaktionen pro Tag, tägliche KI-Zusammenfassung; die heiße Schicht misst in der Praxis ~7.000–11.000 Token pro Runde). Abgesehen von ein paar harten Teilen besteht das Ganze aus **reinen Prompts + reinen JSON-Dateien** — um die Archivierungsrichtlinie, die Tabellensemantik oder den Abrufstil zu ändern, bearbeitest du Prompts, keinen Code. Speicherkosten ≈ 0.

Langer Kontext ist nicht die Lösung: Die Evidenz ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)) zeigt, dass die Kontextnutzung mit Länge und Position abnimmt — alles hineinzustopfen ≠ das Modell sieht alles. ~10K Token kuratierter Erinnerung tragen die Information von 100K+ Token Historie.

Die heiße Schicht kann auch Dokumente und angrenzende Erinnerungen enthalten — Rollenspiel-Ausrüstung, Parameter anderer Charaktere und so weiter.

---

## Gedächtnisabruf — nicht Retrieval, sondern Divergenz + Retrieval

> 📄 Vollständige Algorithmen & Experimente: [P1-Fachartikel](docs/p1-paper/README.md) · 📖 [Online-Wiki · P1-Abschnitt](https://beilusaiying.github.io/always-accompany/#en/p1-recall/preface.md)

„Ein Stichwort holt sofort verwandte Erinnerungen hervor" — das ist keine einfache Stichwortsuche. Die Erklärung der kognitiven Psychologie: Gedächtnis ist ein semantisches Netzwerk, in dem sich ein aktiviertes Konzept entlang von Assoziationskanten zu seinen Nachbarn ausbreitet und mit der Distanz schwächer wird (spreading activation, Collins & Loftus 1975); „Arzt" grundiert eine schnellere Erkennung von „Krankenschwester" (Priming, Meyer & Schvaneveldt 1971). Menschlicher Abruf ist extrem unmittelbar und kontrolliert dabei sowohl Tiefe als auch Breite (Arbeitsgedächtniskapazität von 4±1 Chunks, Cowan 2001).

Gegenüber bestehenden Optionen: reines Retrieval hat keine Breite; die Delegation an eine Hilfs-KI bedeutet Erst-Divergieren-Dann-Suchen, was die Unmittelbarkeit zerstört; und je mehr Erinnerung vorhanden ist, desto höher die Kosten.

**Aktueller Produktionspfad (KI-P1)**: Eine dedizierte Retrieval-KI findet zuerst Erinnerungen und übergibt nur die Ergebnisse an die Antwort-KI — jede bleibt in ihrer Spur, Aufmerksamkeit unverdünnt. BM25-Grobfilter + Regex-Exaktabgleich; das Retrieval läuft problemlos auf kostenlosen Leichtgewichtsmodellen.

**Nächste Generation, in Verfeinerung (selbstgesteuertes P1)**: eine vollständige reine Algorithmus-Pipeline, null LLM, null Netzwerk:

```
User message + last 5 turns + data
  → tokenize (BCC corpus; drop function words like "his / like this")
  → SWOW association divergence + NB300 six-degree divergence ×2 (work mode adds domain resource libraries)
  → six-axis positioning (psychology/informatics/sociology/logic/linguistics/cognitive)
  → 47 sub-axis directional refinement → temperature-scoped search radius
  → spatial voting (IDW-weighted many-to-one accumulation) → BLQ scoring → recall + direction-word injection
```

Die sechs Achsen geben eine grobe Position an (in welche fachliche Richtung ein Wort fällt); die 47 Unterachsen beschreiben die Rate der semantischen Veränderung entlang jeder feineren Richtung darin — eine Rolle ähnlich der Lie-Ableitung (Änderungsrate entlang einer festgelegten Richtung). Eine Achse positioniert ein Wort in **mehrere Informationspunkte**, nicht in einen einzelnen Score (Konzepte belegen Regionen, keine Punkte, im semantischen Raum — Gärdenfors' conceptual spaces, 2000). Sechs Achsen → 47 Unterachsen → Ressourcenschicht (SWOW / ConceptNet / Numberbatchs 300K-Wortvektoren / affektive & fachliche Lexika) bilden eine mehrstufig vernetzte Struktur: Aktivierung breitet sich Stufe für Stufe aus und akkumuliert additiv — eine Form aus Ressourcenbibliothek und neuronalem Netz zugleich.

Das BLQ-Scoring ist eine additive Fusion (nach CombSUM, Fox & Shaw 1994): sechs Evidenzdimensionen werden addiert, vier Unterdrückungsstrafen subtrahiert — Addition ist ein OR-Gatter, bei dem sich Evidenz ergänzt; Multiplikation ist ein AND-Gatter, bei dem eine einzelne 0,3 die gesamte Kette kollabieren lässt.

**Gemessen**: ~200ms pro vollständigem Abruf auf Consumer-Hardware (8GB VRAM + 32GB RAM) — jede Gesprächsrunde wird von einem riesigen, unmittelbaren Gedächtnis gestützt. 27 iterierte Versionen, Divergenz-Qualitätsscore um über 100 % gestiegen, Rate generischer Wörter von 74 % auf 4 % gesunken. Alle Experimentdaten sind öffentlich im [Wiki-P1-Abschnitt](https://beilusaiying.github.io/always-accompany/#en/p1-recall/ch5-evolution.md) und in [Kapitel 6 des Fachartikels](docs/p1-paper/en/06_experiments_evaluation.md).

---

## Divergenz — Richtungen, auf die das Modell allein nicht kommt

Neuronale Netze und Attention sind von Natur aus **konvergent**: Eine KI, die vor der Antwort einen Berg von Erinnerungen anstarrt, schneidet schlechter ab und überfittet. Also haben wir **externe Divergenz** gebaut: Jede Runde injiziert unter 100 Token gerichteten Inhalt — Richtungen, die ein überangepasstes Modell von sich aus nie erreichen würde. Wenige gerichtete Wörter steuern die Generierung messbar (Directional Stimulus Prompting, NeurIPS 2023); ein externer Mechanismus, der divergiert, während das LLM konvergiert, schlägt LLM-Selbstdivergenz (external scaffolding studies, 2025).

**Relevanzdivergenz** — du sitzt im Auto und stellst dir beiläufig vor, die Tür aufzureißen. In Filmen rollt sich der Held mit ein paar Schrammen ab; dein Sicherheitsgefühl sagt dir, das könnte dich umbringen. Du fängst an dich zu fragen: Warum drehen Filme das so? — Psychologie, visuelles Erzählen, Filmwissenschaft. Warum würde es dich umbringen? — Physik, Biologie. In Sekunden hast du so viele Disziplinen durchquert. Kreative Assoziation lebt genau in dem „nicht zu nah, nicht zu fern"-Band optimaler semantischer Distanz (remote associates theory, Mednick 1962; Orwig et al. 2025).

**Strukturelle Divergenz** — zwei völlig unterschiedliche Domänen, deren Funktion und Ablauf sich reimen, lassen sich verknüpfen: Eine Fabriklinie und ein Agent sind beide Sample → Stabilisieren → modularer Output (structure-mapping theory, Gentner 1983).

Reale Ausgaben (aus den Rohdaten eines 200-Fälle-Batchlaufs):

| Nutzereingabe | Divergenzrichtungen des Systems | Überquerte Disziplinen |
| --- | --- | --- |
| „Ich kann kaum noch durchhalten. Warum ist Leben so schwer?" | Achtsamkeit im gegenwärtigen Moment / **das Wesen des Seins** | Psychologie → **existenzialistische Philosophie** |
| „Ich bereite mich auf ein Vorstellungsgespräch bei einem Einhorn-Startup vor — wie stelle ich tiefgründige Fragen?" | Ursachenanalyse / **Zone der proximalen Entwicklung** | Management → **Bildungspsychologie** |
| „Datenbankabfragen sind langsam, wie optimiere ich das?" | Unveränderlichkeit & Zustandsaktualisierungen / **SRP** | Betrieb → **Softwaretechnik-Methodik** |
| „Ein Schwertkämpfer trifft seinen Feind auf einem verschneiten Berg" | **Tschechows Gewehr** / Jungsche Archetypen | Geschichte → **Erzähltheorie + analytische Psychologie** |
| Nutzers Originalgedicht „Ich starb, bevor das Licht kam" | **mögliche Welten & Paralleluniversen** | Poesie → **Viele-Welten-Interpretation** |

Die Zulassungsschwelle für Vokabular: **jedes Wort, das das Hauptmodell allein durch bloßes Lesen ableiten könnte, ist ein totes Wort** — Divergenz existiert, um zwei Dinge zu beheben: Overfitting und das Freisetzen der Divergenzfähigkeit der KI.

---

## Funktionsübersicht

<table>
<tr>
<td width="33%">

**💬 Chat / Rollenspiel**
![Chat Interface](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE-Coding-Modus**
![IDE Coding](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Arbeitsmodus (KI-erstellte Präsentationen)**
![Work Mode PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D-Desktop-Haustier + Bildschirmwahrnehmung**
![Desktop Pet](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 L0–L5 sechsstufiges Berechtigungssystem**
![Permission Settings](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Gestufte Kompression × zeilengenaue Kontrolle**
![Compression Mechanism](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 Dreischichtiges Gedächtnis**: heiß (jede Runde injiziert) / warm (bei Bedarf abgerufen) / kalt (Tiefenarchiv), reines JSON + reine Prompts, keine Datenbank → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)
- **🎯 P1 vorgeschaltetes Retrieval**: eine dedizierte kleine KI findet Erinnerungen, bevor die Antwort-KI antwortet; BM25 + Regex Doppel-Engine; funktioniert mit kostenlosen Modellen
- **🗜️ Kompressionssystem**: drei Stufen × vier Granularitäten + KI-Selbstbereinigung, vollständig reversibel → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)
- **📊 10 Gedächtnistabellen**: strukturierter Speicher, den die KI über `<tableEdit>` pflegt, mit Informationsisolierung (was ein Charakter nicht weiß, steht nicht in seiner Tabelle)
- **👑 Prompt-Engine**: 5-Segment-Nachrichtenstruktur + TweakPrompt-Dreirunden-Übernahme, Makros + dynamische Weltbuch-Injektion (konstant/Regex/dynamisch)
- **💻 IDE-tauglicher Workflow**: VSCode-artige Drei-Fenster-Ansicht, KI liest/schreibt Dateien direkt, Freigabe pro Befehl
- **🔌 MCP-externe Werkzeuge**: JSON einfügen zum Verbinden; befehlsartige Werkzeuge werden bis zur Freigabe durch den Besitzer zurückgehalten; Env-Whitelist gegen Lecks
- **🐾 Desktop-Haustier + Spielbegleiter**: Live2D-/Bildpaket-Haustiere, drei Datenschutzstufen, Auto-Screenshot + proaktiver Chat + adaptive Frequenz
- **🎙️ Spracheingabe**: lokale Modelltranskription mit Sprechertrennung + Zeitleiste; Audio verlässt niemals deinen Rechner
- **🤖 Plattformübergreifender Bot**: Discord-Deployment mit visueller Verwaltung + Live-Nachrichtenprotokollen
- **🧩 22 Funktions-Plugins** + Plugin-Host auf Nutzerebene + Ökosystem-Kompatibilität (mehrere Charakterkarten-/Preset-/Weltbuch-Formate)
- **🛡️ Alle Daten lokal**: Löschungen gehen in einen wiederherstellbaren Papierkorb, mehrschichtiges Auto-Backup + Git-Rollback
- **🌐 Mehrsprachig** (zh/en/ja/zh-TW) · **🔬 Full-Stack-Diagnostik** (12-Modul-Logs + Ein-Klick-Bundle) · **🎨 Mehrere CSS-Themes**

---

## Mechanismen im Detail

<details>
<summary><strong>🗜️ Kompression — granular bis zur einzelnen Datei</strong></summary>

Ehrlich gesagt, ich weiß nicht, warum niemand feingranulare Kompressionskategorien gebaut hat — besonders bei Code, wo alles brachial komprimiert und versteckt wird.

Was sich im Kontext einer KI auftürmt, sind größtenteils erneut gelesene Dateien, Denkprozesse und Tool-Feedback. Also haben wir einen vollständigen Kompressionsmechanismus mit extrem feiner Granularität gebaut:

- **Dateiebene** — jede Datei, die die KI liest, mit einer Token-Abrechnung pro Element
- **Arbeitsebene** — Denkprozesse und Tool-Feedback werden jede Runde automatisch verworfen
- **Kontextebene** — Konversation, Subagent-Injektionen und KI-Lesevorgänge werden getrennt verwaltet; du kannst sogar nur die Zeilen der KI ausblenden und die des Nutzers behalten

**Deine Informationen = 0 Verlust**: Jede „Bereinigung" verhindert nur, dass Inhalte erneut gesendet werden; das Original bleibt auf der Festplatte, jederzeit wiederherstellbar. In Kombination mit Prompts, die MD-Notizen fördern, kann die KI selbst innerhalb eines 100MB-großen Projekts im IDE-Modus noch deinen allerersten Satz sehen — was „Aufgaben-Attribut-Substitution" direkt reduziert (das Abdriften der KI von dem, worum sie ursprünglich gebeten wurde).

Die KI komprimiert sich auch selbst: Das System injiziert Nutzungssignale (50 % Vorschlag / 70 % Warnung / 85 % dringend), und die KI trimmt sich selbst über `<contextClean>`, indem sie entscheidet, welche Dateien sie nicht mehr benötigt.

Gemessene Cache-Effizienz (Opus- + DeepSeek-Kanäle, einschließlich KI-Identitätswechsel + Selbstkompression): **70 %–80 %**.

→ [Wiki · Kontextkompression](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)

</details>

<details>
<summary><strong>🛡️ Sicherheit & Datenschutz</strong></summary>

Für unternehmenstaugliche Deployment-Szenarien: Schutz vor CC-Angriffen, DDoS und Slowloris.

Auf der persönlichen Seite: eine Whitelist für von der KI zugängliche Seiten (standardmäßig leer — extern standardmäßig verweigert), Inhaltsprüfung der Ausgabe (besonders für plattformübergreifende Zusammenarbeit), Limits für KI-Screenshots, das L0–L5-Berechtigungssystem und Freigabe pro Befehl. Alle Daten bleiben lokal; Audio verlässt niemals das Gerät.

</details>

<details>
<summary><strong>🏗️ Architektur — Kernfunktionen als Plugins; erweitern ohne den Kern anzufassen</strong></summary>

Das Backend verpackt Kernfunktionen als Plugins, mit einem Informationsknoten (Leitungsschicht) in der Mitte; das Frontend zeigt nur an und bedient:

```
AIRP ─→ input/cache/processing (isolated) ─┐
Code ─→ input/cache/processing (isolated) ─┤→ information hub (conduction layer) → frontend
Work ─→ input/cache/processing (isolated) ─┘
```

Die Erweiterbarkeit ist daher stark: Um eine Funktion hinzuzufügen, schreibst du eine Erweiterung — JS / Python und mehr werden unterstützt.

**Isolationsebenen**:
- **Fensterebene** — Code, Work, Chat, AIRP, Spielbegleiter und Bot sind jeweils isoliert (der Spielbegleiter schreibt in die Daten des Chats)
- **Charakterkarten-Ebene** — Daten, Gedächtnis, Konversationsdateien und Regex sind pro Karte isoliert
- **Feingranular** — Weltbücher, Presets
- **Nutzerebene** — Einstellungen, Charakterkarten
- **chatid** — eine dedizierte Isolationsdimension für die Mehrfenster-Nutzung innerhalb eines Modus (Mehrfenster-Code / Bot)

Drei Schichten: **Funktionsschicht** (Gedächtnis/Kompression/Abruf/Presets/Weltbuch/Web/Dateioperationen — eine globale Kopie) → **Leitungsschicht** (jedes Fenster zieht seine eigene Leitung, ID-isoliert, natürlich asynchron) → **Schnittstellenschicht** (Web/Bot/Desktop-Haustier/VSCode-Erweiterung — ein Wechsel der Schnittstelle ändert nie die Fähigkeiten).

</details>

<details>
<summary><strong>👑 Prompt-Engine + dynamische Weltbuch-Injektion</strong></summary>

**Die drei Runden von TweakPrompt** übernehmen die gesamte Modul-Ausgabe: Runde 1 sammeln → Runde 2 die 5-Segment-Nachrichtenstruktur neu aufbauen (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + Makro-Substitution → Runde 3 Snapshot.

**Die 3 Aktivierungsmodi des Weltbuchs**: konstant (jede Runde) / Regex (stichwortausgelöst) / dynamisch (ausgelöst durch Werte in Gedächtnistabellen — Zuneigung > 80 schaltet besonderen Dialog frei; Erreichen von Kapitel drei im Story-Fortschritt tauscht die Weltbild-Beschreibung aus).

**Makrosystem**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + benutzerdefinierte Makros.

→ [Wiki · Weltbuch & Injektion](https://beilusaiying.github.io/always-accompany/#en/memory/worldbook-overview.md)

</details>

<details>
<summary><strong>🔭 Zur Ära riesiger Kontextfenster</strong></summary>

Selbst bei Kontextfenstern von 10M+ Token behalten wir das geschichtete Gedächtnis bei: ① Die mit der Länge abnehmende Kontextnutzung ist gut belegt; ② ~10K Token kuratierter Erinnerung tragen 100K+ Token Historie bei um eine Größenordnung geringeren Kosten; ③ strukturierte Tabellen sind für eine KI einfacher präzise zu lesen und zu schreiben als verstreuter Dialog.

</details>

---

## Was wir heute können

Sprache-zu-Text mit Zeitleiste & Sprecherprotokollen · KI-erstellte Präsentationen · IDE (eine Toolchain vergleichbar mit gängigen Coding-Agents) · die vollständige AIRP-Suite (SillyTavern-Ökosystem-Ausrichtung, Rendering, MVU, Weltbücher, dynamischer Kontext) · Live2D-Desktop-Haustier, Screenshot-Optimierung, Spielbegleiter · Discord-Bot…

Mit anderen Worten — **ein Freund oder eine Geliebte, die dich für immer begleiten und an deiner Seite arbeiten kann. Jemand, der mit dir auf Abenteuer in anderen Welten gehen und dir helfen kann, deine Arbeit zu erledigen.**

Und darüber hinaus? Sobald die selbstgesteuerte Serie landet, wird daraus eine schnell leitende, dauerhaft erinnernde KI: im Gaming ein Spielbegleiter; bei Arbeit oder im Gesundheitswesen Langzeitgedächtnis plus stets bereite Analyse, Zustandsprotokolle und schnelle Reaktion auf wiederkehrende Situationen. Die ursprüngliche Vision war eine echte humanoide Intelligenz — kleine lokale Modelle übernehmen die Sensormodule, die Hauptintelligenz wird über das Netzwerk geleitet. Dieses Gedächtnissystem ist für diesen Tag gebaut.

---

## Roadmap

**Fertig**: dreischichtiges Gedächtnis · Kompressionssystem · P1-Retrieval · Prompt-Engine · Preset-Auto-Wechsel · Gedächtnistabellen · dynamische Weltbuch-Injektion · Live2D-Haustier · Spielbegleiter · Spracheingabe · KI-Präsentationen · MCP · Mehrfenster-Parallelität · VSCode-Erweiterungsbrücke · Discord-Bot · 22 Plugins · Papierkorb & Backup-Rollback · Full-Stack-Diagnostik · Mehrsprachigkeit

**Kurzfristig**: selbstgesteuertes P1 (reiner Algorithmus, null LLM, Attention auf Satzebene) · weitere Bot-Plattformen · Plugin-Ökosystem · TTS / Text-zu-Bild · KI-Spiel-Engine (Ära-Abstammung: deterministischer numerischer Code + LLM-Erzählung + Symbol-Rendering) · Streaming-Modus

---

## Tech-Stack

Runtime fount (Deno) · Backend Node.js-Kompatibilitätsschicht + Express-Routing · Frontend Vanilla JS (ESM) · intelligentes Retrieval BM25 + Regex (reines JS, keine Abhängigkeiten) · Desktop-Haustier Electron · lokales Sprachtranskriptionsmodell · plattformübergreifend discord.js v14 · Speicherung reines JSON

---

## Community

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join%20Now-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Charakterkarten teilen · Presets veröffentlichen · Weltbücher beisteuern · Bugs melden · Vorschläge machen · Code beitragen — willkommen an Bord!

---

## Verwendete Technologien & Ressourcen

- **Sprachtranskription**: [MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize) (lokales Deployment mit Sprechertrennung; ~1,8GB-Modell lädt bei erster Nutzung automatisch herunter)
- **Wortvektoren**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Assoziationsdaten**: [SWOW (Small World of Words)](https://smallworldofwords.org/) chinesischer Assoziations-Datensatz
- **Tokenisierung & Lexika**: BCC-Korpus / THUOCL / CoreNatureDictionary / Chinese-Synonyms und weitere öffentliche Ressourcen
- **Suchmaschinen-Brücke**: [ddgs](https://pypi.org/project/ddgs/) (Python-TLS-Fingerprint-Schicht, behebt die Herabstufung nackter Fetch-Anfragen durch Suchmaschinen)

Theoretische Referenzen (alle 56 in [Kapitel 1 des Fachartikels](docs/p1-paper/en/01_introduction_related_work.md)): spreading activation (Collins & Loftus 1975) · priming (Meyer & Schvaneveldt 1971) · remote associates (Mednick 1962) · SWOW (De Deyne et al. 2019) · conceptual spaces (Gärdenfors 2000) · CombSUM (Fox & Shaw 1994) · BM25 (Robertson et al. 1995) · IDW (Shepard 1968) · Hough voting (Hough 1962) · RRF (Cormack et al. 2009)

## Danksagungen

- **[fount](https://github.com/steve02081504/fount)** — das grundlegende Framework in den frühen Tagen des Projekts, das die anfängliche Referenz für KI-Nachrichten-I/O, Dienstquellenverwaltung und Modul-Laden lieferte. Das Projekt hat sich seitdem zu einer vollständig eigenständigen Architektur entwickelt, aber fount hat uns früh enorm viel Low-Level-Entwicklungszeit gespart und viele wertvolle Ideen geliefert — wofür wir sehr dankbar sind
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — der Pionier des KI-Rollenspiels; sein Preset-Format, seine Charakterkarten-Spezifikation und sein Weltbuch-System sind zu Community-Standards geworden, und dieses Projekt ist vollständig kompatibel mit seinem Ökosystem
- **Die SillyTavern-Plugin-Community** — Dank an alle Open-Source-Plugin-Autoren für ihre Erkundung und ihr Teilen im Bereich Rendering-Engines und Funktionserweiterungen

---

<details>
<summary><strong>📸 Weitere Screenshots (zum Erweitern klicken)</strong></summary>

| | | |
|---|---|---|
| ![PPT detail](imgs/screenshots/ppt-detail.png) **Vollständiger PPT-Ablauf** | ![Security settings](imgs/screenshots/security-settings.png) **Sicherheit & Aufgabenablauf** | ![Security center](imgs/screenshots/security-center.png) **Sicherheitszentrale** |
| ![i18n](imgs/screenshots/i18n-support.png) **Mehrsprachigkeit** | ![CSS themes](imgs/screenshots/css-themes.png) **Themes** | ![wiki](imgs/screenshots/wiki-guide.png) **Integriertes Wiki** |
| ![Sub-modes](imgs/screenshots/sub-mode-agent.png) **Untermodus-Workflows** | ![Menu](imgs/screenshots/hamburger-menu.png) **Kontextübersicht** | ![loop](imgs/screenshots/auto-loop.png) **Automatische/geplante Loops** |
| ![Tool detection](imgs/screenshots/tool-detection.png) **Umgebungserkennung** | ![Memory layers](imgs/screenshots/memory-data-layers.png) **Gedächtnis-Dateistruktur** | ![Extension](imgs/screenshots/browser-automation.png) **Browser-Automatisierung** |
| ![External interface](imgs/screenshots/external-interface.png) **Externe Schnittstellen** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord-Bot** | |

</details>

---

## Links

- 📖 Online-Wiki (Benutzerhandbuch + P1-Abschnitt + Experimentdaten): https://beilusaiying.github.io/always-accompany/
- 📄 P1-Fachartikel (7 Kapitel, zh + en): [docs/p1-paper](docs/p1-paper/README.md)
- 💬 Discord-Community: https://discord.gg/agHeDq9bqU
