<p align="center">
  <img src="imgs/icon.jpg" alt="always-accompany" width="180">
</p>

<h1 align="center">always-accompany</h1>

<p align="center"><strong>Un projet IA + Agent pluriel, centré sur le contexte et les mécanismes d'attention</strong></p>

<p align="center">Compagnie, discussion, programmation et travail partagent le même cadre de mémoire et de contexte — comme ces IA de science-fiction : elle vous tient compagnie, et elle vous aide à travailler.</p>

<p align="center"><strong>Attention dynamique · Injection fixe · Isolation par projet · Modes spécialisés</strong></p>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Rejoindre_la_communauté-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Mettre_une_étoile_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README_CN.md">简体中文</a> · <a href="README_TW.md">繁體中文</a> · <a href="README_JA.md">日本語</a> · <a href="README_KO.md">한국어</a> · <a href="README_RU.md">Русский</a> · <a href="README_DE.md">Deutsch</a> · <a href="README_ES.md">Español</a> · Français · <a href="README_PT.md">Português</a></p>

> [!NOTE]
> **Note de développement :** L'essentiel de ce projet a été réalisé par une seule personne en environ trois mois, puis près d'un mois a été consacré à l'optimisation des algorithmes. En raison de ce cycle de développement court et du large périmètre fonctionnel, la structure du projet, les fonctions de base et le traitement des cas limites peuvent encore être instables ou incomplets. Certaines fonctions de base ont été mises en œuvre avec l'aide de l'IA, tandis que l'auteur a personnellement planifié et dirigé les cadres, algorithmes et choix de conception essentiels des fonctions complexes ; la maturité varie donc selon les modules. Les revues manuelles, les ajustements et l'optimisation technique se poursuivront. Si vous rencontrez un bug, merci de fournir les étapes de reproduction et les journaux.
>
> **Suite prévue :** Aucun nouveau plugin ni domaine fonctionnel ne sera ajouté. Le travail se concentrera sur la réduction du cœur, la diminution du couplage et le transfert progressif des fonctions séparables vers la couche des plugins. Le projet complétera un protocole de plugins détaillé et stable avant d'engager l'optimisation technique du framework et une refactorisation progressive. Les tests, la documentation et le processus de contribution seront également améliorés afin que davantage de développeurs puissent comprendre, étendre et rejoindre le projet.

---

## Qu'est-ce qu'il sait faire tout de suite ?

- Mener des discussions au long cours et du jeu de rôle, avec import direct des fiches de personnage, préréglages et lorebooks de SillyTavern et d'autres formats communautaires ;
- Lire et modifier les fichiers d'un projet et exécuter des commandes, à la manière d'un établi Agent local ;
- Sortir du navigateur via Live2D / animal de bureau en image, conscience de l'écran, compagnon de jeu, saisie vocale, et un système de Bot couvrant 9 plateformes ;
- Conserver les matériaux de long terme dans des fichiers locaux, retrouver automatiquement à chaque tour les fragments pertinents pour la question du moment, et laisser sortir l'ancien contexte devenu inutile ;
- Éditer les personnages, le contenu et l'ordre des prompts, l'identité et la position des injections, les règles de déclenchement conditionnel, les routes de rappel mémoire, les permissions et les plugins — pour en faire votre propre IA.

**Qu'avons-nous ?** Derrière ces interfaces se trouve un seul et même système ; la vraie différence tient à quatre choses :

- **Un cadre de mémoire et de contexte singulier** — Data + les couches hot / warm / cold conservent les matériaux de long terme, et un outil de collecte de contexte et de récupération de mémoire (P1) rappelle avant chaque réponse les fragments pertinents du moment ; le nettoyage de contexte descend à la granularité de la lecture de fichier, il est réversible, et l'IA peut aussi renoncer d'elle-même à un fichier déjà lu dont elle n'a plus besoin (dans l'environnement de l'auteur, l'efficacité du cache mesurée selon la facturation est d'environ 70–80 %, ce n'est pas une valeur garantie) ;
- **Tout le contenu est éditable** — personnages, prompts, injections, mémoire, routes de rappel, permissions et plugins ne sont pas des boîtes noires ; quelle que soit la couche que vous voulez modifier, il y a une porte d'entrée ;
- **Un cadre hautement extensible** — les fonctions centrales sont organisées en plugins, transitent par une station d'information intermédiaire, et le frontend ne fait qu'afficher et opérer ; les plugins utilisateur peuvent être écrits en JS, Python ou en programme autonome ;
- **Tout ce qu'un agent sait faire** — fichiers, commandes, navigateur, MCP, multi-fenêtres, approbation et restauration au complet, partageant le même cadre de mémoire et de contexte ; il est né pour mener à bien de grands projets, et son cœur est justement de placer une attention limitée là où elle compte.

---

## Démarrage rapide

Il ne faut que deux choses :

- une API IA fonctionnelle ;
- savoir écrire des prompts simples.

Avec ces deux éléments, vous pouvez vous lancer tout de suite. Une précision : les prompts d'AIRP et de Chat sont encore en cours de peaufinage — à ce stade la priorité va à la productivité, et le polissage orienté compagnie viendra progressivement.

Si vous voulez simplement commencer à discuter, c'est là tout le coût. Le service de récupération local du P1 auto-piloté (pic de mémoire mesuré actuellement de l'ordre d'environ 2 Gio) peut être entièrement désactivé ; les paramètres de P1, la position d'injection des prompts, Code, Work et les plugins relèvent d'une configuration à approfondir selon les besoins, et non d'un cours préalable à une première utilisation.

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# ou chmod +x run.sh && ./run.sh   # Linux / macOS
```

Le lanceur télécharge automatiquement le runtime Deno s'il manque, et complète l'installation si les dépendances sont incomplètes. Une fois la page prête, le navigateur s'ouvre généralement tout seul ; vous pouvez aussi accéder manuellement à `http://localhost:1314`.

| 1. Choisir la langue de l'interface | 2. Lier une source de service IA |
|---|---|
| ![Choisir la langue](imgs/screenshots/onboarding-language.png) | ![Lier l'API](imgs/screenshots/onboarding-api.png) |

Renseignez l'adresse du service, la clé d'API et le modèle ; après enregistrement, choisissez ou importez une fiche de personnage et vous pouvez commencer à discuter. Il faut au moins une API IA fonctionnelle ; les capacités du modèle et les coûts dépendent du service que vous liez. L'application intègre un [Wiki complet](site/wiki/getting-started/overview.md), et vous pouvez aussi consulter la [version en ligne](https://beilusaiying.github.io/always-accompany/).

> Le premier lancement est généralement plus long : le runtime doit télécharger les dépendances et initialiser les données locales. Attendez que la page apparaisse complètement avant d'agir ; les lancements suivants seront plus rapides. Les capacités optionnelles comme la voix ou l'animal de bureau peuvent avoir leur propre premier téléchargement ou leurs propres exigences d'environnement.

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

**📊 Mode Work et PPT**
![Mode Work PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Animal de bureau Live2D + conscience de l'écran**
![Animal de bureau](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 Six modèles de permission + règles par outil**
![Réglages des permissions](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ Compression par paliers × contrôle ligne par ligne**
![Mécanisme de compression](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧭 Quatre modes principaux + vues auxiliaires** : Smart tout-intelligent, Chat discussion / jeu de rôle, Code programmation, Work travail — chacun avec sa propre table de mémoire et sa route P1 ; s'ajoutent des vues auxiliaires : gestion des Bot, compagnon de jeu, gestion de la mémoire, adaptation ST, etc. ;
- **🧠 Data (table de mémoire structurée et éditable) + mémoire à trois couches** : Data et les fichiers JSON / MD ordinaires `hot / warm / cold` prennent en charge respectivement les faits du moment, les matériaux récents et l'archivage ; le contenu est consultable et éditable ;
- **🎯 P1 (rappel mémoire anticipé)** : avant que l'IA principale ne réponde, on cherche d'abord les fragments pertinents parmi les matériaux de long terme que le personnage et le mode courants ont le droit de lire. Chat / Code / Work utilisent actuellement par défaut la route algorithmique locale ; les modes Smart / Bot conservent une route de récupération IA indépendante ; les deux routes sont mutuellement exclusives et peuvent aussi être désactivées ;
- **🗜️ Gestion du contexte** : visualisez l'occupation par message, lecture de fichier, résultat d'outil et injection système ; le nettoyage ordinaire ne fait que masquer le contenu et cesser de l'envoyer à l'IA, l'enregistrement reste sur le disque et peut être restauré ;
- **📊 Tables de mémoire par mode** : Chat dispose des tables #0–#9, Code et Work utilisent leurs propres tables et répertoires privés, sans empiler toutes les situations dans une même table ;
- **👑 Tous les prompts sont éditables** : le contenu, l'ordre, l'activation, l'identité system / user / assistant, la position d'injection et les conditions sont tous ajustables ;
- **💻 Flux de travail de niveau IDE** : disposition en trois panneaux, lecture et édition de fichiers, exécution de commandes, listes de tâches, multi-fenêtres et pont d'extension VS Code ;
- **🔌 MCP (protocole de connexion d'outils externes)** : collez un JSON pour connecter des outils externes ; les services de type commande passent par des portes de sécurité — owner et liste blanche de variables d'environnement, entre autres ;
- **🐾 Animal de bureau et compagnon de jeu** : Live2D / packs d'images, trois modes de conscience de l'écran, commentaires spontanés, boucle de compagnon de jeu indépendante et fréquence adaptative ;
- **🎙️ Saisie vocale locale** : transcription locale MOSS-Transcribe-Diarize, avec séparation des locuteurs et horodatage ; pour l'instant uniquement de la voix vers le texte, sans lecture vocale par l'IA ;
- **🤖 Bot sur 9 plateformes** : le code source actuel contient les enveloppes Discord, Telegram, Slack, LINE, Feishu, DingTalk, WeChat, WeChat Entreprise et X ; chaque plateforme requiert encore la configuration de son Token, Webhook ou pont tiers propre ;
- **🔎 Récupération vectorielle sémantique optionnelle** : beilu-vectordb intégré (basé sur Orama, avec recherche plein texte / vectorielle / hybride), désactivé par défaut, à activer après avoir configuré votre propre point de terminaison d'embedding ; complémentaire du P1 auto-piloté, et non un choix binaire ;
- **🧩 Système de plugins** : le code source actuel comporte 23 répertoires de plugins intégrés, le modèle nouvel utilisateur en liste 14 par défaut ; vous pouvez aussi écrire des plugins utilisateur en Python, Node ou en programme autonome ;
- **🛡️ Données locales et restauration** : les données de l'application sont conservées sur la machine, avec restauration depuis le masquage, corbeille et chaîne de sauvegarde ; le contenu envoyé à une IA distante ou à un service d'embedding distant reste soumis à la politique de données du service que vous avez choisi ;
- **🌐 Multilingue · 🔬 Diagnostic en boîte blanche · 🎨 Plusieurs thèmes** : au-delà des interfaces centrales chinois / anglais / japonais / chinois traditionnel, d'autres traductions communautaires sont proposées, certaines langues peu dotées pouvant être incomplètes.

---

## Que cherchons-nous au juste à résoudre ?

Conserver de la mémoire n'a rien de mystérieux en soi. Data est une table modifiable, et `hot / warm / cold` revient tout simplement à créer trois dossiers selon « temps + événement » et à y consigner des md ; INJ (entrées d'injection de prompt éditables) et les préréglages prolongent la façon d'orchestrer les prompts explorée de longue date par les frontends de personnage comme SillyTavern.

Mais les combiner, puis y ajouter P1 (un outil de collecte de contexte et de récupération de mémoire), donne naturellement un écosystème « vecteur + injection dynamique + mémoire qui suit la tâche du moment » — une base de mémoire à haute attention et à haute densité d'information ; associée à notre compression descendue au niveau du fichier, toute la chaîne est alors complète.

En réalité, au départ, nous comptions faire de P1 une petite IA déployée séparément. Mais le vrai problème surgit après la conservation : la mémoire s'accumule de plus en plus ; si chaque tour exige de lancer une deuxième IA rien que pour fouiller, la vitesse et le coût tiennent-ils encore ? Une petite IA trouve-t-elle vraiment tout ? Faut-il absolument une IA payante ? Plus on retient, plus on ralentit ?

Ramené au quotidien, ce sont quelques scènes familières : un grand projet où vous demandez à l'IA de d'abord examiner la chaîne, le cadre et les MD avant de lui confier la tâche, et à mi-parcours les tokens sont presque saturés — une seule compression oblige à tout relire ; quand plusieurs agents tournent ensemble, le contexte devient une catastrophe ; dans une longue tâche, l'IA relit sans cesse le même fichier dont seules quelques lignes ont changé, le contexte enfle jusqu'à exploser sans que vous puissiez rien supprimer ; parfois vous vouliez ouvrir un nouveau projet, mais l'IA s'ancre d'emblée sur la mémoire de l'ancien.

Ce ne sont pas des hypothèses en l'air :

- [Issue #6](https://github.com/beilusaiying/always-accompany/issues/6)
- [Codex #35226](https://github.com/openai/codex/issues/35226) · [Claude Code #34556](https://github.com/anthropics/claude-code/issues/34556) ;
- [Discussion communautaire](https://www.reddit.com/r/SillyTavernAI/comments/1q7p33c/how_longterm_memory_works_in_sillytavernai/) ;
- Les utilisateurs des produits de chat web soulèvent aussi la transparence de la mémoire de projet et les interférences entre projets : [demande de transparence de la récupération](https://community.openai.com/t/feature-request-make-project-memory-transparent-searchable-and-user-controlled/1385159) · [demande de mémoire propre au projet](https://community.openai.com/t/project-specific-memory-in-chatgpt/1140856).


### Après la conservation, comment restituer à l'IA

Grâce au **rappel mémoire anticipé P1** développé en interne : il commence par étendre les indices de recherche autour de la conversation en cours de l'utilisateur, puis extrait le texte original pertinent parmi les matériaux de long terme que le personnage et le mode courants ont le droit de lire, et le remet à l'IA principale. On peut le voir comme un mécanisme d'attention dynamique fonctionnant hors du modèle — la question du moment décide de ce que l'on cherche, les matériaux de long terme fournissent les candidats, et seuls les fragments retenus au tour courant entrent dans la réponse.

À l'usage, cela signifie : vous n'avez pas à répéter la phrase d'origine, une formulation pertinente sans être exactement identique peut aussi ramener un souvenir ancien ; après le rappel, l'interface affiche quelles mémoires ont réellement servi au tour courant — ce que vous vérifiez, c'est l'enregistrement lui-même, et non un « je m'en souviens » de l'IA.

---

## Mécanismes détaillés

<details>
<summary><strong>🧠 Data et la mémoire récursive à trois couches — pourquoi la stratifier malgré tout</strong></summary>

`hot / warm / cold` sont d'abord des répertoires de cycle de vie lisibles et modifiables, pas une base de données mystérieuse :

```text
🔥 hot  — matériaux récents, à haute fréquence, en cours d'utilisation
🌤️ warm — matériaux d'organisation et d'archivage par étapes
❄️ cold — matériaux historiques de plus long terme
📊 Data — faits structurés éditables et vérifiables dans le mode courant
```

La stratification donne à l'injection fixe, au rappel à la demande et à l'archivage profond des coûts et des usages différents. Les matériaux bruts restent dans des JSON / MD ordinaires, que l'utilisateur peut inspecter et corriger directement ; P1 décide ensuite de quelles couches il rapatrie les fragments pour le tour en cours.

La recherche sur le contexte long a déjà observé un biais de position et une baisse d'exploitation à mesure que la tâche se complexifie : [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) · [RULER](https://arxiv.org/abs/2404.06654) · [Found in the Middle](https://aclanthology.org/2024.findings-acl.890/). Ces articles montrent que « pouvoir y être placé » et « être exploité de façon stable » ne sont pas la même chose, mais ne prouvent pas directement que l'approche de ce projet soit meilleure.

</details>

<details>
<summary><strong>🗜️ Gestion du contexte — de la compression par blocs au nettoyage au niveau de la lecture de fichier</strong></summary>

Une IA qui exécute de vraies tâches produit un grand volume de contenu de processus : fichiers relus à répétition, anciens résultats d'outils, étiquettes d'instruction déjà consommées et messages obsolètes. always-accompany offre à la fois compression automatique, nettoyage par type et sélection ligne par ligne ; le nettoyage par défaut utilise le marqueur `_hidden`, qui laisse l'enregistrement sur le disque mais cesse de l'envoyer à l'IA.

L'IA peut aussi émettre `<contextClean>` pour demander un nettoyage ; le système protège les propos originaux de l'utilisateur et permet de fixer un seuil minimal de tokens, afin d'éviter de casser fréquemment le cache de prompt lorsque le contexte est encore petit. Les opérations permanentes ou à haut risque ne doivent pas être mêlées au masquage ordinaire.

| Compression multi-couches et granularité | Nettoyage au niveau de la lecture de fichier |
|---|---|
| ![Panneau de compression multi-couches](imgs/screenshots/compression-multi.png) | ![Nettoyage au niveau de la lecture de fichier](imgs/screenshots/context-file-cleanup.png) |

L'utilisateur ordinaire n'a qu'à choisir les lectures de fichier ou les messages devenus inutiles ; pour un contrôle plus poussé, il peut ensuite consulter la facturation en tokens, le type, la date et la source.

</details>

<details>
<summary><strong>🔬 P1 auto-piloté — une chaîne d'attention mémoire dynamique hors du modèle</strong></summary>

La chaîne de production actuelle va de Node0 à Node4, et non les 21 nœuds décrits dans l'ancienne documentation :

```text
Node0  entrée courante + messages utilisateur récents + Data du mode courant
  ↓
Node1  segmentation, catégorie grammaticale, temps, noms propres et ancres de phrase
  ↓
Node2  expansion associative via SWOW / ConceptNet / Cilin / ATOMIC / lexiques de domaine, etc.
  ↓
Node3  filtrage par signaux multi-évidence : BLQ (algorithme interne) / NB300 / WordNet, etc.
  ↓
Node4  retour vers Data, hot / warm / cold et les enregistrements de mode, avec classement combinant BM25, temps, couche, Top, importance, etc.
  ↓
recalledRecords + directionWords + trace
```

Les mots associés ne sont pas des faits mémorisés ; les candidats doivent revenir à la couche des enregistrements réels pour devenir des résultats de rappel finaux. Le panneau en boîte blanche affiche les unités d'entrée, les candidats de chaque nœud et les raisons de suppression, l'état de l'index, les sources finales et les erreurs, ce qui aide à juger si un « non rappelé » vient d'une absence de correspondance, d'une dégradation de ressource ou d'une défaillance de la chaîne.

![Test en boîte blanche du P1 auto-piloté](imgs/screenshots/p1-self-driven-diagnostics.png)

Le panneau en boîte blanche prouve que chaque nœud et chaque source réelle sont inspectables ; la qualité du rappel doit encore être évaluée sur un même corpus, une même tâche et des données assorties de réponses de référence. Pour les limites de fonctionnement complètes, voir le [contrat de production actuel de P1](site/wiki/p1-recall/ch7-current-runtime.md).

</details>

<details>
<summary><strong>👑 Tous les prompts sont éditables — utilisables par défaut, et transformables en votre propre IA</strong></summary>

Les entrées de prompt — réglage du personnage, règles système, description de mode, emplacements de données mémoire et tutoriels d'outils — sont toutes éditables dans l'interface. Chaque entrée est ajustable :

- le texte réel
- l'ordre
- l'activation ou non
- l'envoi sous l'identité system, user ou assistant ;
- la position d'insertion dans l'historique de chat ;
- l'effet limité à Chat, Code, Work, Bot ou à des conditions spécifiées.

</details>

<details>
<summary><strong>🔒 L'IA peut agir, mais chaque type d'opération a sa propre limite</strong></summary>

L'écriture de fichiers obtient un `deny / ask / allow` selon l'outil, le chemin et une règle à trois états ; les commandes passent en plus par une liste noire, une liste grise et une liste blanche distante ; en déploiement server, les configurations sensibles et les capacités de sous-processus nécessitent l'activation par l'owner.

L0–L5 est un ensemble de modèles rapides allant du contrôle strict à l'autorisation totale, que l'utilisateur peut encore affiner jusqu'à l'outil et au chemin précis. L5 saute l'approbation, c'est un choix à haut risque explicite ; la clôture de l'espace de travail, le mode de déploiement et les portes de sécurité propres à chaque plugin restent à comprendre indépendamment.

![Affinage des permissions d'édition de l'IA](imgs/screenshots/ai-permission-rules.png)

</details>

<details>
<summary><strong>🏗️ Architecture du système et frontières d'isolation</strong></summary>

always-accompany fonctionne avec un backend Deno et un frontend Web natif, et organise ses capacités via Shell, Plugin, Service Generator et la couche fonctionnelle yonban. Appels d'interface, routage de mode, exécution de fichiers / d'outils, persistance et résultats asynchrones ont chacun une porte d'entrée bien définie.

| Frontière | Rôle actuel |
|---|---|
| Utilisateur | Frontière racine de persistance dans les scénarios multi-utilisateurs / server |
| Fiche de personnage | Différents personnages, relations, clients ou projets utilisent des racines de mémoire, réglages et conversations distincts |
| Mode | Chat / Code / Work utilisent des tables, répertoires privés, enregistrements de préréglage et routes P1 différents ; les matériaux de long terme communs à une même fiche restent partageables |
| Fenêtre | Contraint l'entrée du tour courant, les candidats et résultats P1, l'espace de travail et le retour asynchrone |

</details>

<details>
<summary><strong>🔭 À propos des fenêtres de contexte de 1M, 2M et au-delà</strong></summary>

Des fenêtres plus grandes ont énormément de valeur, mais capacité, attention, coût et état de la tâche ne sont pas une seule et même chose. always-accompany fait de la stratification et du rappel avant tout pour accroître l'attention et optimiser la façon de stocker dans le contexte, en particulier face aux grands projets de code actuels et aux discussions au long cours.

Vous l'avez peut-être vécu : plus la discussion dure et plus la mémoire grossit, plus l'IA reçoit de choses, mais plus ses réactions et sa mémoire se brouillent et ralentissent ; côté code, c'est — même avec 1M de contexte, un grand projet peut aussitôt heurter la limite.

</details>

---

## Feuille de route

**Portes d'entrée et implémentations déjà présentes dans le dépôt actuel** : Data + mémoire à trois couches · gestion du contexte · P1 auto-piloté / P1 IA · édition de tous les prompts et changement de préréglage · tables de mémoire par mode · injection dynamique de connaissances conditionnelles · animal de bureau Live2D / en image · conscience de l'écran et compagnon de jeu · saisie vocale locale · génération de PPT · MCP · multi-fenêtres · pont d'extension VS Code · Bot sur 9 plateformes · 23 répertoires de plugins intégrés · hôte de plugins utilisateur · chaîne corbeille / sauvegarde · diagnostic en boîte blanche · multilingue et thèmes.

**Orientations récentes** : davantage de plateformes de Bot · écosystème et exemples de plugins · TTS / génération d'image à partir de texte · moteur de jeu IA (état numérique déterministe + narration LLM + rendu symbolique)

---

## Pile technique

Runtime Deno (compatible Node.js) · routage style Express · frontend JavaScript / ESM natif · WebSocket · stockage local JSON / MD · animal de bureau Electron · services Python optionnels (ressources P1, STT, PPT) · discord.js v14 · pont d'extension VS Code.

Pour la description de l'architecture, voir [Architecture du système](site/wiki/developer/architecture.md) ; pour les chaînes de messages, d'outils et de permissions, voir le [système d'outils YonBan](site/wiki/yonban/tools.md) et le [mécanisme d'approbation](site/wiki/yonban/approval.md).

---

## Communauté

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Rejoindre_maintenant-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Partagez des fiches de personnage · publiez des préréglages et des connaissances conditionnelles · contribuez des plugins · signalez des bugs · proposez de vrais cas d'usage · participez aux benchmarks · contribuez du code.

---

## Technologies et ressources utilisées

- **Transcription vocale** : [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize) (déploiement local, modèle d'environ 1,8 Go, téléchargé séparément à la première utilisation)
- **Vecteurs de mots** : [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Données d'association** : les données d'association chinoises [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Segmentation et dictionnaires** : THUOCL, CoreNatureDictionary, Chinese-Synonyms et d'autres ressources publiques
- **Pont moteur de recherche** : [ddgs](https://pypi.org/project/ddgs/) (pour les requêtes de recherche et la récupération des résultats)

## Remerciements

- **[fount](https://github.com/steve02081504/fount)** — le cadre de référence des débuts du projet, qui a fourni des pistes d'infrastructure comme le traitement des messages IA, la gestion des sources de service et le chargement des modules, et a permis d'économiser beaucoup de temps de développement bas niveau ;
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — un pionnier majeur de l'écosystème du jeu de rôle IA et des prompts. always-accompany prend en charge l'import de ses fiches de personnage, préréglages, lorebooks et autres formats communautaires ;
- **La communauté de plugins SillyTavern et tous les auteurs de ressources open source** — merci pour l'exploration et le partage autour du rendu, des personnages, des extensions, de la récupération et des chaînes d'outils.

## Pourquoi ce projet

> La conception, l'architecture et le développement de ce projet ont été menés par un jeune sans emploi cherchant du travail (grosse blague), à l'aide de la programmation assistée par IA, en combinant conception d'algorithmes, pistes de bio-inspiration, architecture logicielle et raisonnement logique.

always-accompany n'a pas été fait pour entasser des fonctions à la mode dans un même menu — au départ, l'auteur voulait simplement l'utiliser lui-même :). Cela dit, il possède bel et bien un système complet de plugins et de cadre, et il est compatible avec plusieurs langues.

---

<details>
<summary><strong>📸 Plus de captures d'écran de fonctionnalités (cliquez pour développer)</strong></summary>

| | | |
|---|---|---|
| ![Détail PPT](imgs/screenshots/ppt-detail.png) **Flux complet PPT** | ![Réglages de sécurité](imgs/screenshots/security-settings.png) **Sécurité et flux de tâches** | ![Centre de sécurité](imgs/screenshots/security-center.png) **Centre de protection et de sécurité** |
| ![Multilingue](imgs/screenshots/i18n-support.png) **Support multilingue** | ![Thèmes CSS](imgs/screenshots/css-themes.png) **Plusieurs thèmes** | ![Wiki](imgs/screenshots/wiki-guide.png) **Wiki intégré** |
| ![Sous-mode](imgs/screenshots/sub-mode-agent.png) **Flux de sous-mode** | ![Menu](imgs/screenshots/hamburger-menu.png) **Aperçu du contexte** | ![Loop](imgs/screenshots/auto-loop.png) **Loop automatique / planifié** |
| ![Détection d'outils](imgs/screenshots/tool-detection.png) **Détection d'environnement** | ![Couches de mémoire](imgs/screenshots/memory-data-layers.png) **Structure des fichiers de mémoire** | ![Extension](imgs/screenshots/browser-automation.png) **Automatisation du navigateur** |
| ![Interface externe](imgs/screenshots/external-interface.png) **Interface externe** | | |

</details>
