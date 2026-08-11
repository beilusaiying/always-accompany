<p align="center">
  <img src="imgs/icon.jpg" alt="always-accompany" width="180">
</p>

<h1 align="center">always-accompany</h1>

<p align="center"><strong>Ein vielseitiges KI- und Agent-Projekt mit Fokus auf Kontext- und Aufmerksamkeitsmechanismen</strong></p>

<p align="center">Begleitung, Chat, Programmieren und Arbeit teilen sich denselben Gedächtnis- und Kontextrahmen — eine KI wie aus der Science-Fiction, die dich begleitet und dir zugleich bei der Arbeit hilft.</p>

<p align="center"><strong>Dynamische Aufmerksamkeit · Feste Injektion · Projekt-Isolation · Spezialisierte Modi</strong></p>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Community_beitreten-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Gib_einen_Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README_CN.md">简体中文</a> · <a href="README_TW.md">繁體中文</a> · <a href="README_JA.md">日本語</a> · <a href="README_KO.md">한국어</a> · <a href="README_RU.md">Русский</a> · Deutsch · <a href="README_ES.md">Español</a> · <a href="README_FR.md">Français</a> · <a href="README_PT.md">Português</a></p>

> [!NOTE]
> **Entwicklungshinweis:** Der Großteil dieses Projekts wurde von einer Person in etwa drei Monaten fertiggestellt; anschließend wurde rund ein Monat gezielt in die Optimierung der Algorithmen investiert. Wegen der kurzen Entwicklungszeit und des großen Funktionsumfangs können Projektstruktur, Grundfunktionen und die Behandlung von Randfällen derzeit noch instabil oder unvollständig sein. Einige Grundfunktionen wurden mit KI-Unterstützung umgesetzt, während der Autor Rahmen, Algorithmen und zentrale Entwürfe komplexer Funktionen selbst geplant und angeleitet hat. Daher unterscheiden sich die Reifegrade der Module. Manuelle Prüfung, Feinabstimmung und technische Optimierung werden fortgesetzt. Bitte geben Sie bei Fehlern Reproduktionsschritte und Protokolle an.
>
> **Nächste Schritte:** Neue Plugins und Funktionsbereiche werden nicht mehr hinzugefügt. Der Schwerpunkt liegt künftig auf der Verkleinerung des Kerns, der Verringerung von Kopplungen und der schrittweisen Verlagerung trennbarer Funktionen in die Plugin-Ebene. Das Projekt wird ein detailliertes, stabiles Plugin-Protokoll vervollständigen und anschließend das Framework technisch optimieren und schrittweise refaktorieren. Gleichzeitig werden Tests, Dokumentation und Beitragsabläufe verbessert, damit mehr Entwickler das Projekt verstehen, erweitern und daran mitwirken können.

---

## Was kann es direkt tun?

- Langfristige Chats und Rollenspiele führen — mit direktem Import von Community-Formaten aus SillyTavern wie Charakterkarten, Presets und Worldbooks;
- Wie eine lokale Agent-Werkbank Projektdateien lesen und ändern sowie Befehle ausführen;
- Über Live2D- / Bild-Desktop-Pets, Bildschirmwahrnehmung, Spielbegleitung, Spracheingabe und ein Bot-System für 9 Plattformen über den Browser hinausreichen;
- Langfristiges Material in lokalen Dateien ablegen, in jeder Runde automatisch die für die aktuelle Frage relevanten Fragmente heraussuchen und nicht mehr benötigten alten Kontext ausscheiden lassen;
- Charaktere, Prompt-Inhalte und -Reihenfolge, Injektionsidentität und -position, bedingte Auslöseregeln, Gedächtnis-Abrufrouten, Berechtigungen und Plugins bearbeiten und es so zu deiner eigenen KI umbauen.

**Was haben wir?** Hinter diesen Oberflächen steckt dasselbe System; der eigentliche Unterschied konzentriert sich auf vier Dinge:

- **Geschichtetes Gedächtnis und Kontext** — Data + `hot / warm / cold` bewahren langfristiges Material in Schichten auf; ein Werkzeug zum Sammeln von Kontext und Abrufen von Erinnerungen (P1) holt vor jeder Antwort aktuell relevante Fragmente zurück; die Kontextbereinigung arbeitet auf Ebene einzelner Dateilesungen, ist umkehrbar, und die KI kann bereits gelesene, nicht mehr benötigte Dateien selbst verwerfen;
- **Kernverhalten ist einsehbar und konfigurierbar** — für Charaktere, Prompts, Injektionen, Gedächtnis, Abrufrouten, Berechtigungen und Plugins gibt es dokumentierte Bearbeitungs- oder Konfigurationseinstiege;
- **Ein erweiterbarer Plugin-Rahmen** — die Kernfunktionen sind als Plugins organisiert, werden über eine mittlere Informationsstation weitergeleitet, und das Frontend übernimmt Anzeige und Bedienung; Benutzer-Plugins lassen sich in JS, Python oder als eigenständige Programme schreiben;
- **Eine integrierte Agent-Werkzeugkette** — sie stellt Dateien, Befehle, Browser-Integration, MCP, Mehrfenster, Freigabe und Wiederherstellung unter einem Gedächtnis- und Kontextrahmen bereit; tatsächliche Verfügbarkeit und Ergebnisse hängen von Modus, Konfiguration, Umgebung, Modell und angebundenen Diensten ab.

---

## Schnellstart

Du brauchst nur zwei Dinge:

- eine funktionierende AI-API;
- die Fähigkeit, einfache Prompts zu schreiben.

Mit diesen beiden kannst du sofort loslegen. Vorab sei gesagt: An den Prompts für AIRP und Chat arbeiten wir noch im Detail — derzeit liegt der Schwerpunkt auf Produktivität, und der Feinschliff der Begleitseite folgt schrittweise.

Wenn du einfach nur chatten willst, sind das die gesamten Kosten. Der lokale Abrufdienst des selbstgesteuerten P1 (aktuell gemessener Spitzenspeicher in der Größenordnung von etwa 2 GiB) lässt sich als Ganzes abschalten; P1-Parameter, die Position der Prompt-Injektion, Code, Work und Plugins gehören zu den Konfigurationen, in die man sich bei Bedarf vertieft, und sind keine Voraussetzung für die erste Nutzung.

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# oder chmod +x run.sh && ./run.sh   # Linux / macOS
```

Der Launcher lädt bei fehlendem Deno automatisch die Laufzeit herunter und vervollständigt die Installation, falls Abhängigkeiten unvollständig sind. Sobald die Seite bereit ist, öffnet sich der Browser meist automatisch; du kannst auch manuell `http://localhost:1314` aufrufen.

| 1. Oberflächensprache wählen | 2. AI-Servicequelle verbinden |
|---|---|
| ![Sprache wählen](imgs/screenshots/onboarding-language.png) | ![API verbinden](imgs/screenshots/onboarding-api.png) |

Trage Serviceadresse, API-Key und Modell ein, speichere und wähle oder importiere dann eine Charakterkarte — schon kann der Chat beginnen. Es wird mindestens eine funktionierende AI-API benötigt; Modellfähigkeit und Kosten hängen von dem von dir verbundenen Dienst ab. Die App enthält ein [Wiki](site/wiki/getting-started/overview.md), das auch als [Online-Version](https://beilusaiying.github.io/always-accompany/) verfügbar ist.

> Der erste Start dauert meist länger: Die Laufzeit muss Abhängigkeiten herunterladen und lokale Daten initialisieren. Bitte warte, bis die Seite vollständig erscheint, bevor du etwas tust; spätere Starts sind schneller. Optionale Fähigkeiten wie Sprache und Desktop-Pet haben unter Umständen ihren eigenen Erst-Download oder eigene Umgebungsanforderungen.

---

## Funktionsübersicht

<table>
<tr>
<td width="33%">

**💬 Chat / Rollenspiel**
![Chat-Oberfläche](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE-Programmiermodus**
![IDE-Programmierung](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Work-Modus und PPT**
![Work-Modus PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D-Desktop-Pet + Bildschirmwahrnehmung**
![Desktop-Pet](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Sechs Berechtigungsvorlagen + Regeln pro Werkzeug**
![Berechtigungseinstellungen](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Geschichtete Kompression × einzeln steuerbar**
![Kompressionsmechanismus](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧭 Vier Hauptmodi + Hilfsansichten**: Smart (voll intelligent), Chat (Chat / Rollenspiel), Code (Programmieren) und Work (Arbeit) haben jeweils eigene Gedächtnistabellen und P1-Routen; hinzu kommen Hilfsansichten wie Bot-Verwaltung, Spielbegleitung, Gedächtnisverwaltung und ST-Adaption;
- **🧠 Data (editierbare strukturierte Gedächtnistabelle) + dreischichtiges Gedächtnis**: Data sowie die gewöhnlichen JSON- / MD-Dateien in `hot / warm / cold` übernehmen jeweils aktuelle Fakten, jüngeres Material und Archiv; die Inhalte sind einsehbar und editierbar;
- **🎯 P1 (vorgelagerter Gedächtnisabruf)**: Bevor die Haupt-KI antwortet, sucht es zunächst aus dem langfristigen Material, das die aktuelle Figur und der aktuelle Modus lesen dürfen, relevante Fragmente heraus. Chat / Code / Work nutzen derzeit standardmäßig die lokale Algorithmusroute; Smart / Bot behalten eine eigene AI-Abrufroute; beide Routen schließen sich gegenseitig aus und lassen sich auch abschalten;
- **🗜️ Kontextverwaltung**: Belegung nach Nachricht, Dateilesung, Werkzeugergebnis und Systeminjektion einsehbar; die normale Bereinigung blendet den Inhalt lediglich aus und sendet ihn nicht mehr an die KI, der Datensatz bleibt aber auf der Festplatte und ist wiederherstellbar;
- **📊 Modusspezifische Gedächtnistabellen**: Chat hat die Tabellen #0–#9, Code und Work verwenden eigene Tabellen und private Verzeichnisse und stapeln nicht alle Szenarien in dieselbe Tabelle;
- **👑 Wichtige Prompt-Einträge sind editierbar**: Charakterdefinitionen, Presets, INJ-Einträge, Modusanweisungen, Gedächtnis-Datenslots und Werkzeughinweise bieten die vom jeweiligen Editor unterstützten Einstellungen für Inhalt, Reihenfolge, Aktivierung, Rolle, Injektionsposition oder Bedingungen; Sicherheits-Wrapper des Rahmens und providerspezifische Nachrichtentransformationen bleiben codegesteuert;
- **💻 IDE-Workflow**: Drei-Spalten-Layout, Datei-Lesen und -Bearbeiten, Befehlsausführung, Aufgabenlisten, Mehrfenster und VS-Code-Erweiterungsbrücke;
- **🔌 MCP (Protokoll zur Anbindung externer Werkzeuge)**: JSON einfügen, um externe Werkzeuge anzubinden; befehlsartige Dienste müssen Sicherheitstore wie owner und Umgebungsvariablen-Whitelist passieren;
- **🐾 Desktop-Pet und Spielbegleitung**: Live2D- / Bildpakete, drei Arten der Bildschirmwahrnehmung, aktive Kommentare, eine eigene Spielbegleitungsschleife und adaptive Frequenz;
- **🎙️ Lokale Spracheingabe**: lokale Transkription mit MOSS-Transcribe-Diarize, mit Sprechertrennung und Zeitstempeln; derzeit nur Sprache-zu-Text, kein Vorlesen durch die KI;
- **🤖 Bots für 9 Plattformen**: Der aktuelle Quellcode enthält Hüllen für Discord, Telegram, Slack, LINE, Feishu, DingTalk, WeChat, WeCom und die Plattform X; jede Plattform benötigt weiterhin die nach eigenen Vorgaben konfigurierten Token, Webhooks oder Drittanbieter-Brücken;
- **🔎 Optionale semantische Vektorsuche**: eingebautes beilu-vectordb (auf Basis von Orama, mit Volltext- / Vektor- / Hybridsuche), standardmäßig ausgeschaltet, wird erst nach eigener Konfiguration eines Embedding-Endpunkts aktiviert; ergänzt das selbstgesteuerte P1, statt eine Entweder-oder-Wahl zu sein;
- **🧩 Plugin-System**: Der aktuelle Quellcode hat 23 eingebaute Plugin-Verzeichnisse, die Vorlage für neue Benutzer listet standardmäßig 14; zudem lassen sich Benutzer-Plugins in Python, Node oder als eigenständige Programme schreiben;
- **🛡️ Lokale Daten und Wiederherstellung**: Die App-Daten werden auf dem eigenen Rechner gespeichert, mit Unterstützung für versteckte Wiederherstellung, Papierkorb und Backup-Kette; an entfernte KI oder entfernte Embedding-Dienste gesendete Inhalte unterliegen weiterhin der Datenrichtlinie des von dir gewählten Dienstes;
- **🌐 Mehrsprachigkeit · 🔬 Whitebox-Diagnose · 🎨 Mehrere Themes**: Neben den Kernoberflächen in Chinesisch / Englisch / Japanisch / Traditionellem Chinesisch gibt es weitere Community-Übersetzungen, wobei einige ressourcenarme Sprachen möglicherweise unvollständig sind.

---

## Was genau wollen wir lösen?

Das Speichern von Erinnerungen an sich ist kein Geheimnis. Data ist eine beschreibbare Tabelle, und `hot / warm / cold` heißt schlicht, dass du nach „Zeit + Ereignis“ drei Ordner anlegst und darin md-Dateien notierst; INJ (editierbare Prompt-Injektionseinträge) und Presets führen zudem die Art der Prompt-Orchestrierung fort, die Charakter-Frontends wie SillyTavern lange erforscht haben.

Kombiniert man sie mit P1 (einem Werkzeug zum Sammeln von Kontext und Abrufen von Erinnerungen), entsteht ein konfigurierbarer Ablauf aus „Vektor + dynamische Injektion + ein Gedächtnis, das der aktuellen Aufgabe folgt“; die Kontextbereinigung auf Ebene einzelner Dateilesungen gehört zur selben Kette. Abruf- und Kompressionsergebnisse hängen weiterhin von Modus, Konfiguration, Material und Modell ab.

Anfangs wollten wir P1 eigentlich als kleine, separat betriebene KI umsetzen. Doch das eigentliche Problem tritt nach dem Speichern auf: Das Gedächtnis wächst immer weiter — wenn in jeder Runde eigens eine zweite KI zum Durchsuchen gestartet werden müsste, wären Geschwindigkeit und Kosten dann noch tragbar? Findet eine kleine KI wirklich alles? Muss es zwingend eine kostenpflichtige KI sein? Wird sie langsamer reagieren, je mehr sie sich merkt?

Im Alltag sind das einige vertraute Szenarien: Bei einem großen Projekt lässt du die KI erst die Abläufe, den Rahmen und die MDs ansehen, bevor du ihr eine Aufgabe gibst — mitten in der Arbeit sind die Token dann fast voll, und nach einer Kompression muss alles erneut durchgesehen werden; laufen mehrere Agents gleichzeitig, wird der Kontext erst recht zur Katastrophe; in langen Aufgaben liest die KI immer wieder dieselbe Datei, in der nur ein paar Zeilen geändert wurden, der Kontext quillt über, aber du kannst ihn nicht löschen; manchmal willst du eigentlich ein neues Projekt beginnen, und die KI verankert sich stur am Gedächtnis des früheren alten Projekts.

Diese sind nicht aus der Luft gegriffen:

- [Issue #6](https://github.com/beilusaiying/always-accompany/issues/6)
- [Codex #35226](https://github.com/openai/codex/issues/35226) · [Claude Code #34556](https://github.com/anthropics/claude-code/issues/34556);
- [Community-Diskussion](https://www.reddit.com/r/SillyTavernAI/comments/1q7p33c/how_longterm_memory_works_in_sillytavernai/);
- Auch Nutzer von Web-Chat-Produkten sprechen die Transparenz des Projektgedächtnisses und projektübergreifende Störeffekte an: [Anfrage zur Abruf-Transparenz](https://community.openai.com/t/feature-request-make-project-memory-transparent-searchable-and-user-controlled/1385159) · [Anfrage nach projektspezifischem Gedächtnis](https://community.openai.com/t/project-specific-memory-in-chatgpt/1140856).


### Nach dem Speichern: wie wird es an die KI ausgegeben?

Über das selbst entwickelte **P1, den vorgelagerten Gedächtnisabruf**: Es erweitert zunächst rund um den aktuellen Dialog des Nutzers die Suchhinweise und sucht dann aus dem langfristigen Material, das die aktuelle Figur und der aktuelle Modus lesen dürfen, den relevanten Originaltext heraus und übergibt ihn der Haupt-KI. Man kann es als einen außerhalb des Modells laufenden dynamischen Aufmerksamkeitsmechanismus verstehen — die aktuelle Frage bestimmt, wonach gesucht wird, das langfristige Material liefert Kandidaten, und nur die in dieser Runde ausgewählten Fragmente gelangen in die Antwort.

In der Nutzung bedeutet das: Du musst den Originalsatz nicht wiederholen, auch ein verwandter, aber nicht völlig identischer Satz kann Vergangenes zurückbringen; nach dem Abruf zeigt die Oberfläche, welche Erinnerungen in dieser Runde tatsächlich verwendet wurden — du überprüfst also den Datensatz selbst, nicht ein „Ich erinnere mich“ der KI.

---

## Mechanismen im Detail

<details>
<summary><strong>🧠 Data und das dreischichtige rekursive Gedächtnis — warum trotzdem Schichten?</strong></summary>

`hot / warm / cold` sind zunächst les- und schreibbare Lebenszyklus-Verzeichnisse, keine mysteriöse Datenbank:

```text
🔥 hot  — jüngstes, häufiges, gerade genutztes Material
🌤️ warm — phasenweise aufbereitetes und archiviertes Material
❄️ cold — längerfristiges historisches Material
📊 Data — im aktuellen Modus editierbare, überprüfbare strukturierte Fakten
```

Die Schichtung verleiht fester Injektion, bedarfsgesteuertem Abruf und tiefer Archivierung unterschiedliche Kosten und Zwecke. Das Ausgangsmaterial bleibt in gewöhnlichen JSON- / MD-Dateien, die Nutzer direkt prüfen und korrigieren können; P1 entscheidet dann, aus welchen Schichten in dieser Runde Fragmente zurückgeholt werden.

Die Forschung zu langen Kontexten hat bereits Positions-Bias und eine sinkende Nutzung bei komplexer werdenden Aufgaben beobachtet: [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) · [RULER](https://arxiv.org/abs/2404.06654) · [Found in the Middle](https://aclanthology.org/2024.findings-acl.890/). Diese Arbeiten zeigen, dass „hineinpassen“ und „stabil nutzbar sein“ nicht dasselbe sind, beweisen aber nicht unmittelbar, dass der Ansatz dieses Projekts besser ist.

</details>

<details>
<summary><strong>🗜️ Kontextverwaltung — von der Kompression ganzer Abschnitte zur Bereinigung auf Dateilesungsebene</strong></summary>

Führt die KI echte Aufgaben aus, entsteht viel Prozessinhalt: wiederholt gelesene Dateien, alte Werkzeugergebnisse, bereits verbrauchte Befehls-Tags und veraltete Nachrichten. always-accompany bietet zugleich automatische Kompression, Bereinigung nach Typ und einzelne Auswahl; die Standardbereinigung nutzt die Markierung `_hidden`, sodass der Datensatz auf der Festplatte bleibt, aber nicht mehr an die KI gesendet wird.

Die KI kann auch `<contextClean>` ausgeben, um eine Bereinigung anzufordern; das System schützt dabei die Originalworte des Nutzers und lässt eine minimale Token-Schwelle festlegen, um zu vermeiden, dass der Prompt-Cache häufig zerstört wird, während der Kontext noch klein ist. Dauerhafte oder hochriskante Operationen sollten nicht mit dem normalen Ausblenden vermischt werden.

| Mehrschichtige Kompression und Granularität | Bereinigung auf Dateilesungsebene |
|---|---|
| ![Panel für mehrschichtige Kompression](imgs/screenshots/compression-multi.png) | ![Bereinigung auf Dateilesungsebene](imgs/screenshots/context-file-cleanup.png) |

Ein normaler Nutzer wählt einfach die nicht mehr benötigten Dateilesungen oder Nachrichten aus; wer tiefer steuern will, sieht sich zusätzlich Token-Abrechnung, Typ, Zeit und Quelle an.

</details>

<details>
<summary><strong>🔬 Selbstgesteuertes P1 — die dynamische Gedächtnis-Aufmerksamkeitskette außerhalb des Modells</strong></summary>

Die aktuelle Produktionskette ist Node0–4, nicht die Beschreibung mit 21 Knoten aus der alten Dokumentation:

```text
Node0  aktuelle Eingabe + jüngste Benutzernachrichten + Data des aktuellen Modus
  ↓
Node1  Tokenisierung, Wortart, Zeit, Eigennamen und Phrasenanker
  ↓
Node2  assoziative Erweiterung über SWOW / ConceptNet / Cilin / ATOMIC / Fachwörter usw.
  ↓
Node3  Filterung mit mehreren Evidenzsignalen wie BLQ (Eigenentwicklung) / NB300 / WordNet
  ↓
Node4  zurück zu Data, hot / warm / cold und den Modus-Datensätzen, sortiert nach BM25, Zeit, Schicht, Top, importance usw.
  ↓
recalledRecords + directionWords + trace
```

Assoziationswörter sind keine Gedächtnisfakten; Kandidaten müssen zur echten Datensatzebene zurückkehren, um zum endgültigen Abrufergebnis zu werden. Das Whitebox-Panel zeigt die Eingabeeinheiten, die Kandidaten jedes Knotens und die Löschgründe, den Indexzustand, die endgültige Quelle und Fehler an, was die Beurteilung erleichtert, ob „nicht abgerufen“ nun an einer fehlenden Übereinstimmung, an einer Ressourcen-Degradierung oder an einem Ausfall der Kette liegt.

![Whitebox-Test des selbstgesteuerten P1](imgs/screenshots/p1-self-driven-diagnostics.png)

Das Whitebox-Panel belegt, dass jeder Knoten und jede echte Quelle überprüfbar sind; die Abrufqualität muss dennoch auf demselben Korpus, derselben Aufgabe und auf Daten mit Gold-Labels bewertet werden. Die vollständigen Laufzeitgrenzen siehe [aktueller P1-Produktionsvertrag](site/wiki/p1-recall/ch7-current-runtime.md).

</details>

<details>
<summary><strong>👑 Wichtige Prompt-Einträge sind editierbar — standardmäßig nutzbar und für deinen Ablauf konfigurierbar</strong></summary>

Wichtige Prompt-Einträge wie Charakterdefinitionen, Presets, INJ-Einträge, Modusanweisungen, Gedächtnis-Datenslots und Werkzeughinweise lassen sich in der Oberfläche bearbeiten. Pro Eintrag sind die tatsächlich vom Editor angebotenen Einstellungen anpassbar; Sicherheits-Wrapper des Rahmens und providerspezifische Nachrichtentransformationen bleiben codegesteuert:

- der tatsächliche Text
- die Reihenfolge
- ob aktiviert
- ob als system, user oder assistant gesendet;
- an welche Position im Chatverlauf eingefügt;
- nur in Chat, Code, Work, Bot oder unter angegebenen Bedingungen wirksam.

</details>

<details>
<summary><strong>🔒 Die KI kann handeln, aber jede Art von Operation hat ihre eigene Grenze</strong></summary>

Dateischreibvorgänge erhalten nach Werkzeug, Pfad und Drei-Zustands-Regel ein `deny / ask / allow`; Befehle durchlaufen zusätzlich Blacklist, Graylist und Remote-Whitelist; unter einer Server-Bereitstellung müssen sensible Konfigurationen und Subprozess-Fähigkeiten vom owner freigeschaltet werden.

L0–L5 sind eine Reihe von Schnellvorlagen von strenger Kontrolle bis vollständiger Freigabe, und Nutzer können weiter bis auf konkrete Werkzeuge und Pfade unterteilen. L5 überspringt die Freigabe und ist eine bewusst hochriskante Wahl; Workspace-Zäune, Bereitstellungsmodus und die eigenen Sicherheitstore der einzelnen Plugins sollten weiterhin unabhängig verstanden werden.

![Feingliederung der KI-Bearbeitungsberechtigungen](imgs/screenshots/ai-permission-rules.png)

</details>

<details>
<summary><strong>🏗️ Systemarchitektur und Isolationsgrenzen</strong></summary>

always-accompany läuft mit einem Deno-Backend und einem nativen Web-Frontend und organisiert seine Fähigkeiten über Shell, Plugin, Service Generator und die yonban-Funktionsschicht. Oberflächenaufrufe, Modus-Routing, Datei- / Werkzeugausführung, Persistenz und asynchrone Ergebnisse haben jeweils klare Einstiege.

| Grenze | Aktuelle Funktion |
|---|---|
| Benutzer | Persistenz-Wurzelgrenze in Mehrbenutzer- / Server-Szenarien |
| Charakterkarte | Verschiedene Charaktere, Beziehungen, Kunden oder Projekte nutzen unterschiedliche Gedächtniswurzeln, Einstellungen und Dialoge |
| Modus | Chat / Code / Work nutzen unterschiedliche Tabellen, private Verzeichnisse, Preset-Datensätze und P1-Routen; gemeinsames langfristiges Material derselben Charakterkarte kann weiterhin geteilt werden |
| Fenster | Beschränkt die Eingabe dieser Runde, die P1-Kandidaten und -Ergebnisse, den Workspace und die asynchrone Rückmeldung |

</details>

<details>
<summary><strong>🔭 Über Kontextfenster von 1M, 2M und größer</strong></summary>

Größere Fenster sind sehr wertvoll, aber Kapazität, Aufmerksamkeit, Kosten und Aufgabenstatus sind nicht dasselbe. always-accompany setzt auf Schichtung und Abruf vor allem, um die Aufmerksamkeit zu erhöhen und die Art der Speicherung im Kontext zu optimieren — besonders im Hinblick auf die heutigen großen Code-Projekte und langfristigen Chats.

Vielleicht kennst du das: Je länger der Chat und je mehr Erinnerungen, desto mehr empfängt die KI, und Reaktion und Gedächtnis geraten stattdessen durcheinander und werden langsamer; beim Programmieren ist es so — selbst mit 1M Kontext stößt ein großes Projekt sofort an die Obergrenze.

</details>

---

## Roadmap

**Bereits im aktuellen Repository vorhandene Einstiege und Implementierungen**: Data + dreischichtiges Gedächtnis · Kontextverwaltung · selbstgesteuertes P1 / AI P1 · Bearbeitung von Prompt-Einträgen und Preset-Wechsel · Modus-Gedächtnistabellen · dynamische Injektion bedingten Wissens · Live2D- / Bild-Desktop-Pet · Bildschirmwahrnehmung und Spielbegleitung · lokale Spracheingabe · PPT-Erzeugung · MCP · Mehrfenster · VS-Code-Erweiterungsbrücke · Bots für 9 Plattformen · 23 eingebaute Plugin-Verzeichnisse · Host für Benutzer-Plugins · Papierkorb- / Backup-Kette · Whitebox-Diagnose · Mehrsprachigkeit und Themes.

**Nahe Richtungen**: mehr Bot-Plattformen · Plugin-Ökosystem und Beispiele · TTS / Text-zu-Bild · KI-Spiel-Engine (deterministischer numerischer Zustand + LLM-Erzählung + symbolisches Rendering)

---

## Technologie-Stack

Deno-Laufzeit (Node.js-kompatibel) · Routing im Express-Stil · natives JavaScript- / ESM-Frontend · WebSocket · lokale JSON- / MD-Speicherung · Electron-Desktop-Pet · optionale Python-Dienste (P1-Ressourcen, STT, PPT) · discord.js v14 · VS-Code-Erweiterungsbrücke.

Zur Architekturbeschreibung siehe [Systemarchitektur](site/wiki/developer/architecture.md), zur Nachrichten-, Werkzeug- und Berechtigungskette siehe [YonBan-Werkzeugsystem](site/wiki/yonban/tools.md) und [Freigabemechanismus](site/wiki/yonban/approval.md).

---

## Community

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Jetzt_beitreten-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Charakterkarten teilen · Presets und bedingtes Wissen veröffentlichen · Plugins beitragen · Bugs melden · echte Anwendungsfälle einbringen · an Benchmarks teilnehmen · Code beitragen.

---

## Verwendete Technologien und Ressourcen

- **Sprachtranskription**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (lokale Bereitstellung, Modell ca. 1,8 GB, wird bei erster Nutzung separat heruntergeladen)
- **Wortvektoren**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Assoziationsdaten**: chinesische Assoziationsdaten aus [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Tokenisierung und Wörterbücher**: öffentliche Ressourcen wie THUOCL, CoreNatureDictionary, Chinese-Synonyms
- **Suchmaschinen-Brücke**: [ddgs](https://pypi.org/project/ddgs/) (für Suchanfragen und das Abrufen von Ergebnissen)

## Danksagung

- **[fount](https://github.com/steve02081504/fount)** — der Referenzrahmen aus der Frühphase des Projekts, der Grundgedanken zur Infrastruktur wie AI-Nachrichtenverarbeitung, Verwaltung von Servicequellen und Modulladen lieferte und viel Zeit für die Entwicklung der unteren Schichten sparte;
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — ein wichtiger Wegbereiter des Ökosystems für KI-Rollenspiel und Prompts. always-accompany unterstützt den Import seiner Community-Formate wie Charakterkarten, Presets und Worldbooks;
- **die SillyTavern-Plugin-Community und alle Autoren von Open-Source-Ressourcen** — Dank für das Erkunden und Teilen bei Rendering, Charakteren, Erweiterungen, Abruf und Werkzeugketten.

## Warum dieses Projekt

> Design, Architektur und Entwicklung dieses Projekts stammen von einem stellungssuchenden Stubenhocker (ähem), der mit KI-gestütztem Programmieren Algorithmusdesign, bionische Ansätze, Rahmenarchitektur und logisches Denken zusammengebracht hat.

always-accompany entstand nicht, um beliebte Funktionen in dasselbe Menü zu stopfen — am Anfang wollte der Autor es einfach nur selbst nutzen :). Es enthält ein Plugin- und Rahmensystem sowie mehrere Oberflächensprachen; der tatsächliche Umfang hängt vom Plugin und den verfügbaren Übersetzungsressourcen ab.

---

<details>
<summary><strong>📸 Mehr Funktions-Screenshots (zum Aufklappen)</strong></summary>

| | | |
|---|---|---|
| ![PPT im Detail](imgs/screenshots/ppt-detail.png) **PPT-Gesamtablauf** | ![Sicherheitseinstellungen](imgs/screenshots/security-settings.png) **Sicherheit und Aufgabenablauf** | ![Sicherheitszentrum](imgs/screenshots/security-center.png) **Sicherheitszentrum** |
| ![Mehrsprachigkeit](imgs/screenshots/i18n-support.png) **Mehrsprachige Unterstützung** | ![CSS-Themes](imgs/screenshots/css-themes.png) **Mehrere Themes** | ![Wiki](imgs/screenshots/wiki-guide.png) **Eingebautes Wiki** |
| ![Submodus](imgs/screenshots/sub-mode-agent.png) **Submodus-Workflow** | ![Menü](imgs/screenshots/hamburger-menu.png) **Kontext-Schnellübersicht** | ![Loop](imgs/screenshots/auto-loop.png) **Automatischer / geplanter Loop** |
| ![Werkzeugerkennung](imgs/screenshots/tool-detection.png) **Umgebungserkennung** | ![Gedächtnisschichten](imgs/screenshots/memory-data-layers.png) **Gedächtnis-Dateistruktur** | ![Erweiterung](imgs/screenshots/browser-automation.png) **Browser-Automatisierung** |
| ![Externe Schnittstelle](imgs/screenshots/external-interface.png) **Externe Schnittstelle** | | |

</details>
