<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Rejoindre_la_communauté-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Mettre_une_étoile_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">简体中文</a> | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | <a href="README_KO.md">한국어</a> | <a href="README_RU.md">Русский</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a> | Français | <a href="README_PT.md">Português</a></p>

> Ce projet a été entièrement conçu, architecturé et développé par un seul étudiant, avec l'aide de la programmation assistée par IA, mobilisant à la fois la conception d'algorithmes, des principes de bio-inspiration, l'architecture logicielle et le raisonnement logique.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# ou chmod +x run.sh && ./run.sh   # Linux/macOS
```

Ouvrez votre navigateur sur `http://localhost:1314` → configurez une source de service IA → importez une fiche de personnage → commencez à discuter. Le runtime Deno se télécharge automatiquement au premier lancement, aucune installation manuelle n'est nécessaire. Il vous faut au moins une clé d'API IA. L'application intègre un wiki complet.

> **Note :** Le premier lancement prend plus de temps — l'environnement doit télécharger les dépendances et initialiser la base de données. Veuillez attendre le chargement complet de la page avant d'interagir. Les lancements suivants seront beaucoup plus rapides.

---

Une mémoire récursive à trois couches (archivage jour → mois → année, JSON pur, capacité de 260 ans) + une IA de récupération anticipée (une IA dédiée qui ne fait que chercher les souvenirs pertinents et les transmet à l'IA de réponse — chacune reste dans son rôle) + un nettoyage de contexte par paliers (nettoyer signifie simplement ne plus renvoyer l'information ; le texte original reste et peut toujours être restauré). Ces trois éléments s'articulent pour que l'IA continue de se souvenir de chaque mot que vous avez prononcé, sans être bridée par la fenêtre de contexte. Sur cette base, nous avons construit le chat/jeu de rôle, un mode de programmation IDE, un mode travail (y compris la création de diaporamas par l'IA), un animal de bureau Live2D (conscience de l'écran + compagnon de jeu), la saisie vocale, un bot Discord et l'intégration d'outils externes MCP — tous les points d'entrée partagent la même mémoire, changer de fenêtre ne fait donc jamais oublier l'IA. En cours d'affinage : un moteur de récupération de nouvelle génération (un pipeline purement algorithmique à 21 nœuds, zéro LLM, zéro réseau, de l'ordre de la milliseconde, visant une attention au niveau de la phrase).

---

## Aperçu des fonctionnalités

<table>
<tr>
<td width="33%">

**💬 Chat / Jeu de rôle**
![Interface de chat](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ Mode programmation IDE**
![Programmation IDE](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Mode travail (diaporamas par IA)**
![Mode travail PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Animal de bureau Live2D + conscience de l'écran**
![Animal de bureau](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Portail de permissions à six niveaux L0–L5**
![Réglages des permissions](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Compression par paliers × contrôle ligne par ligne**
![Mécanisme de compression](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 Mémoire à trois couches** : chaude (injectée à chaque tour) / tiède (récupérée à la demande) / froide (archive profonde), JSON pur + entièrement piloté par prompt, zéro base de données
- **🎯 Récupération anticipée P1** : une petite IA dédiée cherche d'abord les souvenirs puis les transmet à l'IA de réponse, double moteur BM25 + regex, la récupération peut tourner sur un modèle gratuit
- **🗜️ Système de compression** : trois niveaux (un clic / par type / ligne par ligne) × quatre granularités (messages de chat / lectures de fichiers / injections système / contenu de processus) + nettoyage autonome `<contextClean>` par l'IA, tout est réversible
- **📊 10 tableaux de mémoire** : stockage structuré, maintenu automatiquement par l'IA via `<tableEdit>`, assurant l'isolation de l'information (ce que le personnage ne sait pas n'est simplement pas dans le tableau)
- **👑 Moteur de prompts** : structure de message en 5 segments + prise en main en trois passes par TweakPrompt, variables macro + injection dynamique du world book (modes permanent / regex / dynamique)
- **💻 Flux de travail de niveau IDE** : disposition en trois panneaux façon VSCode, l'IA lit et écrit directement les fichiers, exécution des commandes approuvée ligne par ligne
- **🔌 Outils externes MCP** : collez un JSON pour connecter ; les serveurs de type commande sont bloqués par défaut tant que le propriétaire n'approuve pas, avec une liste blanche de variables d'environnement pour éviter les fuites
- **🐾 Animal de bureau + compagnon de jeu** : animal Live2D / pack d'images, trois niveaux de confidentialité, capture d'écran automatique + prise de parole spontanée + fréquence adaptative
- **🎙️ Saisie vocale** : transcription par modèle local, séparation des locuteurs + chronologie, l'audio ne quitte jamais la machine
- **🤖 Bot multiplateforme** : déploiement Discord, gestion visuelle + journal des messages en temps réel
- **🧩 22 plugins de fonctionnalités** + hôte de plugins au niveau utilisateur + compatibilité d'écosystème (import de fiches de personnage/préréglages/world books dans plusieurs formats)
- **🛡️ Toutes les données restent locales** : les suppressions vont dans une corbeille et peuvent être restaurées, sauvegarde automatique multicouche + retour arrière git
- **🌐 Multilingue** (chinois/anglais/japonais/chinois traditionnel) · **🔬 Diagnostics full-stack** (journaux de 12 modules + empaquetage en un clic) · **🎨 Plusieurs thèmes CSS**

---

## Mécanismes détaillés

<details>
<summary><strong>🧠 Mémoire récursive à trois couches — pourquoi la stratifier</strong></summary>

Jeter tout l'historique dans un seul grand bassin ralentit la recherche — et les données expérimentales le confirment ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)) : même présente, l'information n'est pas forcément vue par le modèle. En nous inspirant de la formation des souvenirs par l'hippocampe et de la courbe d'oubli d'Ebbinghaus, nous répartissons l'information en trois couches selon la distance temporelle :

```
🔥 Couche chaude — auto-injectée à chaque tour : profil utilisateur / mémoires permanentes / tâches en attente / souvenirs récents
🌤️ Couche tiède — récupérée à la demande (le dernier mois) : résumés quotidiens / archives temporaires / index mensuel
❄️ Couche froide — récupération profonde (plus d'un mois) : résumés mensuels / résumés quotidiens historiques / index annuel
```

La couche chaude ne coûte qu'environ 7 000–11 000 tokens par tour (5–9 % d'une fenêtre de 128K). La décroissance de la mémoire emprunte à la courbe d'oubli d'Ebbinghaus : `score = weight × (1 / (1 + days × 0.1))`. Entièrement piloté par prompt — changer la stratégie d'archivage, la signification des tableaux ou le style de récupération se fait en éditant le prompt, sans toucher au code.

</details>

<details>
<summary><strong>🎯 IA de récupération anticipée P1 — pourquoi séparer en deux IA</strong></summary>

Si l'IA de réponse devait elle-même trier les éléments pertinents parmi des centaines d'entrées d'historique, elle chercherait et répondrait à la fois, et son attention serait diluée entre les deux tâches. Nous avons donc extrait « chercher les souvenirs » vers une petite IA dédiée :

```
L'utilisateur envoie un message → IA de récupération P1 (< 5K tokens, focalisée uniquement sur la recherche) → souvenirs sélectionnés + conversation en cours → IA de réponse (focalisée uniquement sur la réponse)
```

Filtrage grossier par BM25 + correspondance exacte par regex, atteint la cible en au plus 3 tours. La récupération tourne bien sur un modèle léger gratuit, si bien que le coût réel par conversation équivaut essentiellement à un seul appel de l'IA de réponse. P1 gère aussi le changement automatique de préréglage (avec un délai de refroidissement de 5 tours pour éviter les oscillations).

</details>

<details>
<summary><strong>🗜️ Gestion du contexte — granularité de compression × niveaux × nettoyage autonome par l'IA</strong></summary>

Pendant que l'IA travaille, du contenu de processus s'accumule sans cesse (relire le même fichier, résultats de recherche obsolètes, anciens résultats d'outils). Notre nettoyage se contente toujours de masquer — tout peut être restauré à tout moment.

**Nettoyage autonome par l'IA** : le système fournit à l'IA des signaux sur sa propre utilisation du contexte (50 % suggéré / 70 % avertissement / 85 % urgent), et l'IA utilise les commandes `<contextClean>` pour se dégraisser elle-même. Elle enregistre avant de nettoyer, donc une erreur reste réversible.

**Contrôle fin par l'utilisateur** : trois niveaux (nettoyage complet en un clic / par type / sélection ligne par ligne) × quatre granularités (messages de chat / facturation de tokens par lecture de fichier / cinq catégories cochables d'injections système / contenu de processus dégraissé automatiquement).

Taux de réussite de cache mesuré (Opus + DeepSeek, incluant le changement de persona IA + compression autonome) : **75 %–80 %**.

![Panneau de compression](imgs/screenshots/compression-multi.png)

</details>

<details>
<summary><strong>🔬 P1 auto-piloté — un moteur de récupération zéro-LLM en développement actif</strong></summary>

L'IA P1 doit envoyer une requête API à chaque tour — ce qui implique latence, coût, et impossibilité hors ligne. Nous avons construit un pipeline entièrement algorithmique (21 nœuds, ~9 000 lignes) visant une vitesse de l'ordre de la milliseconde, aucune dépendance réseau, et une attention au niveau de la phrase.

**Fondation de données** : le [réseau d'association chinois SWOW](https://smallworldofwords.org/) / les [vecteurs de mots à 300 dimensions ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (~300 000 mots) / le graphe de relations chinois de ConceptNet / THUOCL et d'autres dictionnaires multi-sources. Le lexique a été assemblé par recherche web IA + 2 jours de relecture, pour un coût de construction proche de zéro.

**Pipeline** : tokenisation → divergence associative SWOW (la diffusion synonymique est interdite — l'activer fait mesurablement chuter la qualité de 55–76 %) → scoring parallèle à six axes (psychologique / informationnel / social / logique / linguistique / cognitif) → localisation en 47 sous-directions → confirmation croisée multi-ressources → classement par vote spatial (IDW additif, non multiplicatif) → divergence secondaire (5 chemins indépendants) → scoring BLQ (référençant la fusion additive CombSUM, avec des pondérations de dimension conçues en interne) → sélection du mot-direction → injection dans le contexte. Les 21 nœuds sont tous purement algorithmiques, zéro LLM.

**Expériences** : 27 itérations de version ; le score de divergence est passé de 2,01 à 4,05 entre v9 et v26 (+101 %, sur 5, jugé mot par mot à la main) ; taux de rappel ~90 % ; score moyen global ~3,5. Le taux de réponses génériques est passé de 74 % à 4 %.

**Sortie réelle** (relevés bruts d'un lot de test de 200 cas) :

| Entrée utilisateur | Direction divergente du système | Discipline atteinte |
| --- | --- | --- |
| « Je n'en peux plus, pourquoi c'est si dur d'être en vie ? » | Conscience du moment présent / conscience intéroceptive / **quelle est la nature du réel** | Psychologie → **philosophie existentialiste** |
| « Je prépare un entretien pour une licorne, comment poser des questions vraiment profondes ? » | Analyse des causes profondes / **zone proximale de développement** | Management → **psychologie de l'éducation** |
| « Récupérer des utilisateurs perdus en trafic propriétaire avec un budget limité » | **Activation du réseau du mode par défaut** / **BDNF (facteur neurotrophique dérivé du cerveau)** | Marketing → **neuroscience cognitive** |
| « Les requêtes de base de données sont horriblement lentes, comment les optimiser » | Immutabilité et mises à jour d'état / **SRP (principe de responsabilité unique)** | Ops → **méthodologie du génie logiciel** |
| « Une histoire d'épéiste rencontrant un ennemi sur une montagne enneigée » | **Fusil de Tchekhov** / archétypes jungiens | Fiction → **narratologie + psychologie analytique** |
| Poème original d'un utilisateur, « Je suis mort avant l'arrivée de la lumière » | **Mondes possibles et univers parallèles** | Poésie → **interprétation à mondes multiples en physique** |

Critère d'admission du lexique : **tout mot que le modèle principal pourrait déjà déduire en lisant la saisie brute est un mot inutile** — la valeur de P1 réside dans le fait de donner au modèle des directions qu'il n'aurait pas trouvées seul.

</details>

<details>
<summary><strong>👑 Moteur de prompts + injection dynamique du world book</strong></summary>

**Les trois passes de TweakPrompt** prennent en charge de manière unifiée la sortie de chaque module : Round 1 collecte → Round 2 reconstruit la structure de message en 5 segments (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + substitution de macros → Round 3 instantané.

**Le world book a 3 modes d'activation** : permanent (injecté à chaque tour) / regex (déclenché par mot-clé) / dynamique (déclenché en lisant des conditions numériques dans les tableaux de mémoire — par ex. affection > 80 débloque un dialogue spécial, ou la progression de quête atteignant le chapitre 3 change la description de l'univers).

**Système de macros** : `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + macros personnalisées.

</details>

<details>
<summary><strong>🏗️ Architecture du système</strong></summary>

Trois couches : **couche fonctionnelle** (mémoire / compression / rappel / préréglages / world book / réseau / opérations sur fichiers… une seule copie globale) → **couche de transport** (chaque fenêtre tire sa propre ligne, isolée par id, naturellement asynchrone et non bloquante) → **couche d'interface** (web / bot / animal de bureau / extension VSCode — changer d'interface sans perdre aucune capacité).

Isolation des données : niveau utilisateur (sources IA / réglages globaux) / niveau fiche de personnage (mémoire / chat / world book / regex) / niveau conversation (historique de chat / mode / sous-mode).

22 plugins grandissent tous sous une spécification unifiée, MCP connecte des outils externes, et l'hôte de plugins au niveau utilisateur monte des programmes Python/Node — les extensions ne touchent jamais au code du noyau.

</details>

<details>
<summary><strong>🔭 À propos de l'ère des fenêtres de contexte géantes</strong></summary>

Même si les fenêtres de contexte s'étendent à plus de 10M de tokens, nous conservons la mémoire par couches : ① il existe des preuves expérimentales solides que l'utilisation du contexte se dégrade avec la longueur ; ② ~10K tokens de mémoire sélectionnée portent l'information de 100K+ tokens d'historique brut, à un coût inférieur d'un ordre de grandeur ; ③ les tableaux structurés sont plus faciles à lire et écrire précisément par une IA que des informations éparpillées dans une conversation.

</details>

---

## Feuille de route

**Terminé** : mémoire à trois couches · système de compression · récupération P1 · moteur de prompts · changement automatique de préréglage · tableaux de mémoire · injection dynamique du world book · animal de bureau Live2D · compagnon de jeu · saisie vocale · diaporamas par IA · MCP · parallélisme multi-fenêtres · pont d'extension VSCode · Discord Bot · 22 plugins · corbeille et retour arrière de sauvegarde · diagnostics full-stack · multilingue

**Plans à court terme** : P1 auto-piloté (algorithme pur, zéro LLM, attention au niveau de la phrase) · plus de plateformes de bot · écosystème de plugins · TTS / texte-vers-image · moteur de jeu IA (dans la lignée des jeux « era » — code déterministe pour l'état numérique + narration par LLM + rendu symbolique) · mode diffusion en direct

---

## Pile technique

Runtime fount (Deno) · Couche de compatibilité Node.js backend + routage style Express · Frontend JS natif (ESM) · Récupération intelligente BM25 + regex (JS pur, zéro dépendance) · Animal de bureau Electron · Modèle de transcription vocale local · discord.js v14 multiplateforme · Stockage JSON pur

---

## Communauté

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Rejoindre_maintenant-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Partagez des fiches de personnage · publiez des préréglages · contribuez des world books · signalez des bugs · proposez des idées · contribuez du code — toutes les contributions sont bienvenues !

---

## Technologies et ressources utilisées

- **Transcription vocale** : [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (déploiement local avec séparation des locuteurs ; le modèle, ~1,8 Go, se télécharge automatiquement à la première utilisation)
- **Vecteurs de mots** : [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Données d'association** : le jeu de données d'association chinois [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Tokenisation et dictionnaires** : THUOCL / CoreNatureDictionary / Chinese-Synonyms et d'autres ressources publiques
- **Pont moteur de recherche** : [ddgs](https://pypi.org/project/ddgs/) (une couche d'empreinte TLS en Python qui résout le problème des requêtes fetch brutes dégradées par les moteurs de recherche)

## Remerciements

- **[fount](https://github.com/steve02081504/fount)** — le cadre de référence initial des débuts de ce projet, fournissant l'infrastructure de base comme la gestion des messages IA, la gestion des sources de service et le chargement des modules. Le projet a depuis évolué vers une architecture entièrement indépendante, mais fount nous a fait gagner beaucoup de temps de développement bas niveau au début et nous a offert de précieuses pistes de réflexion — un sincère merci pour cela
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — le projet pionnier du jeu de rôle par IA ; son format de préréglage, sa spécification de fiche de personnage et son système de world book sont devenus des standards communautaires, et ce projet est entièrement compatible avec son écosystème
- **Communauté de plugins SillyTavern** — merci à tous les auteurs de plugins open source pour leur exploration et leur partage autour des moteurs de rendu, des extensions de fonctionnalités et plus encore

---

<details>
<summary><strong>📸 Plus de captures d'écran de fonctionnalités (cliquez pour développer)</strong></summary>

| | | |
|---|---|---|
| ![Détail PPT](imgs/screenshots/ppt-detail.png) **Flux complet PPT** | ![Réglages de sécurité](imgs/screenshots/security-settings.png) **Sécurité et flux de tâches** | ![Centre de sécurité](imgs/screenshots/security-center.png) **Centre de sécurité** |
| ![Multilingue](imgs/screenshots/i18n-support.png) **Support multilingue** | ![Thèmes CSS](imgs/screenshots/css-themes.png) **Plusieurs thèmes** | ![wiki](imgs/screenshots/wiki-guide.png) **Wiki intégré** |
| ![Sous-mode](imgs/screenshots/sub-mode-agent.png) **Flux de sous-mode** | ![Menu](imgs/screenshots/hamburger-menu.png) **Aperçu du contexte** | ![loop](imgs/screenshots/auto-loop.png) **Loop automatique/planifié** |
| ![Détection d'outils](imgs/screenshots/tool-detection.png) **Détection d'environnement** | ![Couches de mémoire](imgs/screenshots/memory-data-layers.png) **Structure des fichiers de mémoire** | ![Extension](imgs/screenshots/browser-automation.png) **Automatisation du navigateur** |
| ![Interface externe](imgs/screenshots/external-interface.png) **Interface externe** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>
