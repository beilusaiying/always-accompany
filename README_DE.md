<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Community_beitreten-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Star_geben_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">中文</a> | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | Deutsch | <a href="README_ES.md">Español</a></p>

> Das gesamte Projekt — Design, Architektur und Entwicklung — wurde eigenständig von einem frischen Universitätsabsolventen umgesetzt, mithilfe KI-gestützter Programmierung und unter Einbeziehung von Fähigkeiten aus Algorithmendesign, Bionik-Prinzipien, Framework-Architektur und logischem Denken.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# oder chmod +x run.sh && ./run.sh   # Linux/macOS
```

Öffne im Browser `http://localhost:1314` → richte eine AI-Servicequelle ein → importiere eine Charakterkarte → leg los. Die Deno-Laufzeitumgebung lädt sich beim ersten Start automatisch selbst herunter, keine manuelle Installation nötig. Du benötigst mindestens einen AI-API-Key. Die App bringt ein vollständiges, integriertes Wiki-Tutorial mit.

> **Hinweis:** Der erste Start dauert etwas länger — die Laufzeitumgebung muss Abhängigkeiten herunterladen und die Datenbank initialisieren. Bitte warten Sie, bis die Seite vollständig geladen ist. Weitere Starts sind deutlich schneller.

---

Ein dreischichtiges rekursives Gedächtnis (Tag → Monat → Jahr Archivierung, reines JSON, 260 Jahre Kapazität) + eine vorgeschaltete Retrieval-KI (eine dedizierte KI, die ausschließlich relevante Erinnerungen aufspürt und das Gefundene an die Antwort-KI übergibt — jede bleibt in ihrer eigenen Spur) + gestufte Kontextbereinigung (Löschen bedeutet nur, dass etwas nicht erneut gesendet wird; der Originaltext bleibt erhalten und kann jederzeit wiederhergestellt werden). Diese drei Elemente greifen ineinander, sodass die KI sich weiterhin an jedes Wort erinnert, das du je gesagt hast, ohne durch das Kontextfenster begrenzt zu sein. Darauf aufbauend haben wir Chat/Rollenspiel, IDE-Coding-Modus, Arbeitsmodus (inklusive KI-erstellter Präsentationen), einen Live2D-Desktop-Begleiter (Bildschirmwahrnehmung + Spielbegleitung), Spracheingabe, einen Discord-Bot und MCP-Integration externer Tools gebaut — jeder Einstiegspunkt teilt sich dasselbe Gedächtnis, sodass ein Fensterwechsel die KI nicht vergessen lässt, wer du bist. Derzeit in Weiterentwicklung: eine Retrieval-Engine der nächsten Generation (eine rein algorithmische 21-Knoten-Pipeline, null LLM, null Netzwerk, Millisekunden-Geschwindigkeit, mit dem Ziel satzgenauer Aufmerksamkeit).

---

## Funktionsübersicht

<table>
<tr>
<td width="33%">

**💬 Chat / Rollenspiel**
![Chat-Oberfläche](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE-Coding-Modus**
![IDE-Coding](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Arbeitsmodus (KI-erstellte Präsentationen)**
![Arbeitsmodus PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D-Desktop-Begleiter + Bildschirmwahrnehmung**
![Desktop-Begleiter](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 L0–L5 sechsstufiges Berechtigungstor**
![Berechtigungseinstellungen](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Gestufte Kompression × zeilengenaue Kontrolle**
![Kompressionsmechanismus](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 Dreischichtiges Gedächtnis**: heiß (jede Runde injiziert) / warm (bei Bedarf abgerufen) / kalt (Tiefenarchiv), reines JSON + rein prompt-gesteuert, keine Datenbank
- **🎯 P1-Vorab-Retrieval**: eine dedizierte kleine KI sucht zuerst nach Erinnerungen und übergibt sie an die Antwort-KI, BM25 + Regex-Dual-Engine, Retrieval läuft auch mit einem kostenlosen Modell
- **🗜️ Kompressionssystem**: drei Stufen (ein Klick / nach Typ / zeilenweise) × vier Granularitäten (Chat-Nachrichten / Dateilesevorgänge / Systeminjektionen / Prozessinhalte) + KI-autonome `<contextClean>`-Bereinigung, alles reversibel
- **📊 10 Gedächtnistabellen**: strukturierte Speicherung, von der KI automatisch über `<tableEdit>` gepflegt, mit Informationsisolierung (was der Charakter nicht wissen soll, steht schlicht nicht in der Tabelle)
- **👑 Prompt-Engine**: 5-teilige Nachrichtenstruktur + TweakPrompt-Drei-Runden-Übernahme, Makrovariablen + dynamische Weltbuch-Injektion (Dauer-/Regex-/dynamischer Modus)
- **💻 Workflow auf IDE-Niveau**: dreispaltiges VSCode-Layout, KI liest und schreibt Dateien direkt, Befehlsausführung zeilenweise genehmigt
- **🔌 MCP-externe Tools**: Verbindung per eingefügtem JSON-Snippet; befehlsbasierte Server werden standardmäßig blockiert, bis der Owner zustimmt, mit einer Env-Variablen-Allowlist gegen Datenlecks
- **🐾 Desktop-Begleiter + Spielbegleitung**: Live2D-/Bildpaket-Begleiter, drei Privatsphärestufen, automatische Screenshots + eigenständiges Einmischen + adaptive Frequenz
- **🎙️ Spracheingabe**: lokale Modelltranskription, Sprechertrennung + Zeitleiste, Audio verlässt niemals das Gerät
- **🤖 Plattformübergreifender Bot**: Discord-Deployment, visuelle Verwaltung + Echtzeit-Nachrichtenprotokoll
- **🧩 22 Funktions-Plugins** + benutzerebene Plugin-Host + Ökosystem-Kompatibilität (Import von Charakterkarten/Presets/Weltbüchern in mehreren Formaten)
- **🛡️ Alle Daten bleiben lokal**: Löschungen landen im Papierkorb und sind wiederherstellbar, mehrschichtiges Auto-Backup + Git-Rollback
- **🌐 Mehrsprachig** (Chinesisch/Englisch/Japanisch/traditionelles Chinesisch) · **🔬 Full-Stack-Diagnostik** (12-Modul-Logs + Ein-Klick-Verpackung) · **🎨 Mehrere CSS-Themes**

---

## Detaillierte Mechanismen

<details>
<summary><strong>🧠 Dreischichtiges rekursives Gedächtnis — Warum überhaupt schichten</strong></summary>

Die gesamte Historie in einen einzigen großen Pool zu werfen, macht Lookups langsam — und die experimentellen Daten bestätigen das ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)): selbst wenn es drin ist, sieht das Modell es möglicherweise gar nicht. Angelehnt an die Art, wie der Hippocampus Erinnerungen bildet, und an die Ebbinghaus-Vergessenskurve, teilen wir Informationen nach zeitlichem Abstand in drei Schichten:

```
🔥 Heiße Schicht — jede Runde automatisch injiziert: Nutzerprofil / dauerhafte Erinnerungen / ausstehende Aufgaben / jüngste Erinnerungen
🌤️ Warme Schicht — bei Bedarf abgerufen (letzter Monat): Tageszusammenfassungen / temporäre Archive / Monatsindex
❄️ Kalte Schicht — Tiefenabruf (älter als ein Monat): Monatszusammenfassungen / historische Tageszusammenfassungen / Jahresindex
```

Die heiße Schicht kostet nur ~7.000–11.000 Tokens pro Runde (5–9 % eines 128K-Fensters). Der Gedächtnisverfall leiht sich die Ebbinghaus-Vergessenskurve: `score = weight × (1 / (1 + days × 0.1))`. Rein prompt-gesteuert — die Archivierungsstrategie, Tabellenbedeutungen oder den Retrieval-Stil ändern reicht ein Prompt-Edit, keine Code-Änderungen nötig.

</details>

<details>
<summary><strong>🎯 P1-Vorab-Retrieval-KI — Warum in zwei KIs aufteilen</strong></summary>

Wenn die Antwort-KI selbst die relevanten Stellen aus hunderten Verlaufseinträgen heraussuchen muss, sucht und antwortet sie gleichzeitig, und ihre Aufmerksamkeit wird zwischen beiden Aufgaben verdünnt. Also haben wir das „Erinnerungen finden" in eine dedizierte kleine KI ausgelagert:

```
Nutzer sendet Nachricht → P1-Retrieval-KI (<5K Tokens, rein auf Abruf fokussiert) → ausgewählte Erinnerungen + aktueller Chat → Antwort-KI (rein auf Antworten fokussiert)
```

BM25-Grobfilterung + exakter Regex-Abgleich, trifft das Ziel in höchstens 3 Runden. Retrieval läuft problemlos mit einem kostenlosen, leichten Modell, sodass die tatsächlichen Kosten pro Gespräch im Wesentlichen nur einem Aufruf der Antwort-KI entsprechen. P1 übernimmt zudem die automatische Preset-Umschaltung (mit 5-Runden-Cooldown gegen Oszillation).

</details>

<details>
<summary><strong>🗜️ Kontextverwaltung — Kompressionsgranularität × Stufen × KI-autonome Bereinigung</strong></summary>

Während die KI arbeitet, häuft sich ständig Prozessinhalt an (dieselbe Datei erneut lesen, veraltete Suchergebnisse, alte Tool-Ausgaben). Unsere Bereinigung verbirgt Dinge lediglich — alles kann jederzeit wiederhergestellt werden.

**KI-autonome Bereinigung**: Das System liefert der KI Signale über die eigene Kontextnutzung (50 % empfohlen / 70 % Warnung / 85 % dringend), und die KI nutzt `<contextClean>`-Befehle, um sich selbstständig zu verschlanken. Sie schreibt Dinge auf, bevor sie löscht, sodass ein Fehlgriff trotzdem reversibel ist.

**Feingranulare Nutzerkontrolle**: drei Stufen (Ein-Klick-Komplettbereinigung / nach Typ / zeilenweise Handauswahl) × vier Granularitäten (Chat-Nachrichten / zeilengenaue Datei-Lese-Token-Abrechnung / fünf ankreuzbare Kategorien von Systeminjektionen / automatisch getrimmter Prozessinhalt).

Gemessene Cache-Trefferrate (Opus + DeepSeek, inklusive KI-Persona-Wechsel + autonomer Kompression): **75–80 %**.

![Kompressionspanel](imgs/screenshots/compression-multi.png)

</details>

<details>
<summary><strong>🔬 Selbstgesteuertes P1 — Eine Zero-LLM-Retrieval-Engine in aktiver Entwicklung</strong></summary>

Die P1-KI muss jede Runde eine API-Anfrage abfeuern — das bedeutet Latenz, Kosten und keine Offline-Nutzung. Wir haben eine vollständig algorithmische Pipeline gebaut (21 Knoten, ~9.000 Zeilen), die auf Millisekunden-Geschwindigkeit, null Netzwerkabhängigkeit und satzgenaue Aufmerksamkeit zielt.

**Datenbasis**: das [SWOW-chinesische Assoziationsnetzwerk](https://smallworldofwords.org/) / [ConceptNet-Numberbatch-300-dimensionale Wortvektoren](https://github.com/commonsense/conceptnet-numberbatch) (~300.000 Wörter) / ConceptNets chinesischer Beziehungsgraph / THUOCL und weitere Multi-Source-Wörterbücher. Das Lexikon wurde per KI-Websuche + 2 Tage Selbstüberprüfung zusammengestellt, zu nahezu null Aufbaukosten.

**Pipeline**: Tokenisierung → SWOW-assoziative Divergenz (Synonym-Diffusion ist verboten — ihre Aktivierung senkt die Qualität messbar um 55–76 %) → sechsachsige Parallel-Bewertung (psychologisch / informationell / sozial / logisch / linguistisch / kognitiv) → Lokalisierung von 47 Unterrichtungen → Multi-Ressourcen-Gegenbestätigung → räumliches Voting-Ranking (additives IDW, nicht multiplikativ) → Sekundärdivergenz (5 unabhängige Pfade) → BLQ-Bewertung (angelehnt an additive CombSUM-Fusion, mit selbst erforschten Dimensionsgewichten) → Richtungswort-Auswahl → Kontextinjektion. Alle 21 Knoten sind reiner Algorithmus, null LLM.

**Experimente**: 27 Versionsiterationen; der Divergenz-Score stieg zwischen v9 und v26 von 2,01 auf 4,05 (+101 %, von 5, Wort für Wort von Hand bewertet); Recall-Trefferquote ~90 %; Gesamtdurchschnitt ~3,5. Die Quote generischer Allerwelts-Antworten sank von 74 % auf 4 %.

**Echte Ausgabe** (Rohprotokolle aus einem 200-Fälle-Batch-Lauf):

| Nutzereingabe | Divergente Richtung des Systems | Erreichte Disziplin |
| --- | --- | --- |
| „Ich kann kaum noch durchhalten, warum ist Leben so schwer?" | Achtsamkeit im Moment / interozeptives Gewahrsein / **was ist das Wesen des Realen** | Psychologie → **existenzialistische Philosophie** |
| „Bereite mich auf ein Vorstellungsgespräch bei einem Einhorn-Unternehmen vor, wie komme ich auf wirklich tiefgründige Fragen?" | Ursachenanalyse / **Zone der nächsten Entwicklung** | Management → **Bildungspsychologie** |
| „Abgewanderte Nutzer im Owned-Traffic-Marketing mit begrenztem Budget zurückgewinnen" | **Aktivierung des Default-Mode-Netzwerks** / **BDNF (neurotropher Faktor)** | Marketing → **kognitive Neurowissenschaft** |
| „Datenbankabfragen sind quälend langsam, wie optimiere ich sie" | Unveränderlichkeit und Zustandsupdates / **SRP (Single-Responsibility-Prinzip)** | Betrieb → **Software-Engineering-Methodik** |
| „Eine Geschichte über einen Schwertkämpfer, der einem Feind auf einem verschneiten Berg begegnet" | **Tschechows Gewehr** / Jungsche Archetypen | Fiktion → **Erzähltheorie + analytische Psychologie** |
| Ein Originalgedicht eines Nutzers, „Ich starb, bevor das Licht kam" | **Mögliche Welten und Paralleluniversen** | Poesie → **Viele-Welten-Interpretation der Physik** |

Aufnahmekriterium für das Lexikon: **jedes Wort, das das Hauptmodell schon allein durch Lesen der Rohangabe ableiten könnte, ist ein verschwendetes Wort** — der Wert von P1 liegt darin, dem Modell Richtungen zu geben, auf die es von selbst nicht käme.

</details>

<details>
<summary><strong>👑 Prompt-Engine + dynamische Weltbuch-Injektion</strong></summary>

**TweakPrompts drei Runden** übernehmen die Ausgabe jedes Moduls einheitlich: Runde 1 sammelt → Runde 2 baut die 5-teilige Nachrichtenstruktur neu auf (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + Makro-Ersetzung → Runde 3 erstellt einen Snapshot.

**Das Weltbuch hat 3 Aktivierungsmodi**: dauerhaft (jede Runde injiziert) / Regex (Keyword-ausgelöst) / dynamisch (ausgelöst durch Auslesen numerischer Bedingungen aus Gedächtnistabellen — z. B. schaltet Zuneigung > 80 einen speziellen Dialog frei, oder Questfortschritt bis Kapitel 3 tauscht eine andere Weltbild-Beschreibung ein).

**Makrosystem**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + benutzerdefinierte Makros.

</details>

<details>
<summary><strong>🏗️ Systemarchitektur</strong></summary>

Drei Schichten: **Funktionsschicht** (Gedächtnis / Kompression / Recall / Presets / Weltbuch / Netzwerk / Dateioperationen … eine einzige globale Kopie) → **Transportschicht** (jedes Fenster zieht seine eigene Leitung, isoliert per ID, natürlich asynchron und gegenseitig nicht blockierend) → **Interface-Schicht** (Web / Bot / Desktop-Begleiter / VSCode-Erweiterung — Interface tauschen, ohne Fähigkeiten zu verlieren).

Datenisolierung: benutzerebene (KI-Quellen / globale Einstellungen) / charakterkarten-ebene (Gedächtnis / Chat / Weltbuch / Regex) / gesprächsebene (Chatverlauf / Modus / Untermodus).

22 Plugins wachsen alle unter einer einheitlichen Spezifikation, MCP verbindet externe Tools, und der benutzerebene Plugin-Host mountet Python/Node-Programme — Erweiterungen fassen niemals den Kern-Code an.

</details>

<details>
<summary><strong>🔭 Über das Zeitalter riesiger Kontextfenster</strong></summary>

Selbst wenn Kontextfenster auf 10M+ Tokens anwachsen, behalten wir geschichtetes Gedächtnis bei: ① Es gibt solide experimentelle Belege dafür, dass die Kontextnutzung mit zunehmender Länge abnimmt; ② ~10K Tokens kuratiertes Gedächtnis tragen die Information von 100K+ Tokens Rohhistorie, bei einer um eine Größenordnung geringeren Kostenlast; ③ strukturierte Tabellen lassen sich von einer KI genauer lesen und schreiben als über eine Konversation verstreute Informationen.

</details>

---

## Roadmap

**Abgeschlossen**: dreischichtiges Gedächtnis · Kompressionssystem · P1-Retrieval · Prompt-Engine · automatische Preset-Umschaltung · Gedächtnistabellen · dynamische Weltbuch-Injektion · Live2D-Desktop-Begleiter · Spielbegleitung · Spracheingabe · KI-erstellte Präsentationen · MCP · Multi-Fenster-Parallelität · VSCode-Erweiterungsbrücke · Discord-Bot · 22 Plugins · Papierkorb & Backup-Rollback · Full-Stack-Diagnostik · Mehrsprachunterstützung

**Kurzfristige Pläne**: selbstgesteuertes P1 (reiner Algorithmus, null LLM, satzgenaue Aufmerksamkeit) · weitere Bot-Plattformen · Plugin-Ökosystem · TTS / Text-zu-Bild · KI-Spiel-Engine (in der „Era"-Spielereihe — deterministischer Code für numerischen Zustand + LLM-Narrativ + symbolisches Rendering) · Livestreaming-Modus

---

## Technologie-Stack

Laufzeitumgebung fount (Deno) · Backend Node.js-Kompatibilitätsschicht + Express-artiges Routing · Frontend Vanilla JS (ESM) · Smartes Retrieval BM25 + Regex (reines JS, keine Abhängigkeiten) · Desktop-Begleiter Electron · lokales Sprachtranskriptionsmodell · plattformübergreifend discord.js v14 · Speicherung reines JSON

---

## Community

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Jetzt_beitreten-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Charakterkarten teilen · Presets veröffentlichen · Weltbücher beisteuern · Bugs melden · Vorschläge machen · Code beitragen — alle sind willkommen!

---

## Verwendete Technologien & Ressourcen

- **Sprachtranskription**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (lokale Bereitstellung mit Sprecher-Diarisierung; das Modell, ~1,8 GB, lädt sich beim ersten Gebrauch automatisch herunter)
- **Wortvektoren**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Assoziationsdaten**: das [SWOW (Small World of Words)](https://smallworldofwords.org/) chinesische Assoziationsdatenset
- **Tokenisierung & Wörterbücher**: THUOCL / CoreNatureDictionary / Chinese-Synonyms und weitere öffentliche Ressourcen
- **Suchmaschinen-Bridge**: [ddgs](https://pypi.org/project/ddgs/) (eine Python-TLS-Fingerprint-Schicht, die das Problem löst, dass rohe Fetch-Anfragen von Suchmaschinen herabgestuft werden)

## Danksagungen

- **[fount](https://github.com/steve02081504/fount)** — das ursprüngliche Referenz-Framework in der Frühphase dieses Projekts, das Kerninfrastruktur wie KI-Nachrichtenverarbeitung, Servicequellen-Verwaltung und Modul-Laden bereitstellte. Das Projekt hat sich seither zu einer vollständig eigenständigen Architektur entwickelt, aber fount hat uns früh viel Low-Level-Entwicklungszeit erspart und uns viele wertvolle Ideen mitgegeben — aufrichtigen Dank dafür
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — das Pionierprojekt im Bereich KI-Rollenspiel; sein Preset-Format, seine Charakterkarten-Spezifikation und sein Weltbuch-System sind zum Community-Standard geworden, und dieses Projekt ist vollständig kompatibel mit seinem Ökosystem
- **SillyTavern-Plugin-Community** — Dank an jeden Open-Source-Plugin-Autor für ihre Erkundung und ihr Teilen rund um Rendering-Engines, Funktionserweiterungen und mehr

---

<details>
<summary><strong>📸 Weitere Funktions-Screenshots (zum Aufklappen anklicken)</strong></summary>

| | | |
|---|---|---|
| ![PPT-Detail](imgs/screenshots/ppt-detail.png) **Vollständiger PPT-Workflow** | ![Sicherheitseinstellungen](imgs/screenshots/security-settings.png) **Sicherheit & Task-Flow** | ![Sicherheitszentrum](imgs/screenshots/security-center.png) **Sicherheitszentrum** |
| ![Mehrsprachig](imgs/screenshots/i18n-support.png) **Mehrsprachige Unterstützung** | ![CSS-Themes](imgs/screenshots/css-themes.png) **Mehrere Themes** | ![Wiki](imgs/screenshots/wiki-guide.png) **Integriertes Wiki** |
| ![Untermodus](imgs/screenshots/sub-mode-agent.png) **Untermodus-Workflow** | ![Menü](imgs/screenshots/hamburger-menu.png) **Kontext auf einen Blick** | ![Loop](imgs/screenshots/auto-loop.png) **Automatischer/geplanter Loop** |
| ![Tool-Erkennung](imgs/screenshots/tool-detection.png) **Umgebungserkennung** | ![Gedächtnisschichten](imgs/screenshots/memory-data-layers.png) **Gedächtnis-Dateistruktur** | ![Erweiterungen](imgs/screenshots/browser-automation.png) **Browser-Automatisierung** |
| ![Externes Interface](imgs/screenshots/external-interface.png) **Externes Interface** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord-Bot** | |

</details>
