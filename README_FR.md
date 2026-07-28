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

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">Wiki en ligne (guide d'utilisation)</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">Article technique P1</a></p>

> Ce projet a été entièrement conçu, architecturé et développé de manière indépendante par un jeune diplômé universitaire, à l'aide de la programmation assistée par IA, mobilisant des compétences allant de la conception d'algorithmes aux principes de bio-inspiration, en passant par l'architecture des frameworks et le raisonnement logique.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# or chmod +x run.sh && ./run.sh   # Linux/macOS
```

Ouvrez votre navigateur sur `http://localhost:1314` → configurez une source de service IA → importez une fiche de personnage → commencez à discuter. Le runtime Deno se télécharge automatiquement lui-même au premier lancement, aucune installation manuelle n'est nécessaire. Il vous faut au moins une clé d'API IA. L'application intègre un guide wiki complet — également consultable comme [wiki en ligne](https://beilusaiying.github.io/always-accompany/).

> **Note :** Le premier lancement prend plus de temps que d'habitude — l'environnement doit télécharger les dépendances et initialiser la base de données. Veuillez attendre que la page soit entièrement chargée avant d'interagir. Les lancements suivants seront beaucoup plus rapides.

---

## Pourquoi ce projet existe

Vous avez peut-être vu *Detroit: Become Human*, ou *Plastic Memories*. Les IA humanoïdes qu'on y voit sont véritablement intelligentes — à la fois collègues de travail et compagnes de vie, en un seul être. Alors — j'ai décidé d'en construire une pour moi-même.

**Le premier problème à résoudre, c'est la mémoire.**

Les contextes des IA modernes atteignent aujourd'hui le million de tokens, et les outils de stockage de mémoire et de compression ne manquent pas. Mais ils sont soit trop plats, soit ils s'accumulent sans fin à mesure que le temps passe. Vous ne voulez pas que votre compagnon IA oublie les souvenirs que vous avez partagés — pourtant, avec les approches existantes, c'est presque inévitable.

Alors qu'est-ce que la mémoire, *au fond* ? La mémoire humaine est en réalité de courte durée — les détails d'il y a deux jours sont déjà flous. Mais donnez-moi un seul mot-clé, et je peux instantanément faire remonter le souvenir correspondant, ou un souvenir apparenté. Cela pointe vers deux directions : **comment la mémoire est stockée, et comment elle est retrouvée.**

Les humains ne retiennent pas chaque détail ; nous oublions de façon sélective. L'IA d'aujourd'hui, non — elle compresse brutalement, ou déverse tout dans une base vectorielle. Cela trahit la nature même de la mémoire : on n'oublie pas instantanément ce qui vient de se passer, et on ne rejoue pas chaque jour les souvenirs des dernières années.

C'est exactement dans cette logique que nous avons construit le système ci-dessous.

---

## Le système de mémoire — stocker comme un humain, oublier comme un humain

> 📖 Guide illustré complet : [Wiki en ligne · Système de mémoire](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)

Les **tableaux de données** conservent les souvenirs du jour et les souvenirs permanents — de la même façon que vous vous souviendrez toujours du prénom de votre premier amour, de la première chose que vous avez faite ensemble, du jour de la déclaration.

Au-dessus se trouvent trois couches réparties selon la distance temporelle, qui modélisent l'oubli sélectif humain (formation de mémoire par couches + courbe de l'oubli d'Ebbinghaus) :

```
📋 Tableaux de données — souvenirs du jour + souvenirs permanents (chat / code / travail conservés séparément)
🔥 Couche chaude (hebdomadaire) — données quotidiennes archivées automatiquement ; l'IA les classe par temps, événement et fils de processus
🌤️ Couche tiède (mensuelle) — compression de second passage, extraction de mots-clés — comme une table des matières
❄️ Couche froide (annuelle) — archive profonde, toujours accessible en cas de correspondance lors de la récupération
```

**Le poids d'injection diminue par couche** : contexte > données (souvenirs permanents, entrées récurrentes) > chaude > tiède > froide, plus un top-k — un reclassement au sein de chaque couche selon l'activité de rappel récente, avec des couches tampons intercalées. Une hiérarchie de rappel entièrement simulée, plus une couche dynamique.

D'après la façon dont l'IA rédige réellement ses entrées de données et grâce à l'optimisation de l'archivage quotidien, l'injection par tour reste sous les 10 000 tokens même après un an d'utilisation (calcul : ~20 caractères par entrée, ~100 interactions par jour, résumé quotidien par l'IA ; en pratique, la couche chaude mesure ~7 000–11 000 tokens par tour). Hormis quelques parties techniques ardues, l'ensemble repose sur **des prompts purs + des fichiers JSON purs** — pour changer la politique d'archivage, la sémantique des tableaux ou le style de récupération, on modifie des prompts, pas du code. Coût de stockage ≈ 0.

Un contexte long n'est pas le remède : les preuves ([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)) montrent que l'exploitation du contexte décroît avec la longueur et la position — tout y mettre ≠ tout est vu par le modèle. ~10 000 tokens de mémoire sélectionnée portent l'information de 100 000+ tokens d'historique.

La couche chaude peut aussi contenir des documents et des souvenirs annexes — équipement de jeu de rôle, paramètres d'autres personnages, etc.

---

## Rappel de mémoire — pas une simple récupération, mais divergence + récupération

> 📄 Algorithmes et expériences complets : [Article technique P1](docs/p1-paper/README.md) · 📖 [Wiki en ligne · section P1](https://beilusaiying.github.io/always-accompany/#en/p1-recall/preface.md)

« Un mot-clé fait instantanément remonter les souvenirs apparentés » — ce n'est pas une simple recherche par mot-clé. L'explication de la psychologie cognitive : la mémoire est un réseau sémantique où un concept activé se propage le long des liens d'association vers ses voisins, en s'affaiblissant avec la distance (activation par propagation, Collins & Loftus 1975) ; « médecin » facilite une reconnaissance plus rapide d'« infirmière » (amorçage, Meyer & Schvaneveldt 1971). Le rappel humain est intensément instantané, tout en maîtrisant à la fois la profondeur et l'étendue (capacité de la mémoire de travail de 4±1 unités, Cowan 2001).

Face aux options existantes : la simple récupération n'a pas d'étendue ; déléguer à une IA assistante signifie diverger puis chercher, ce qui tue l'instantanéité ; et plus on a de mémoire, plus le coût augmente.

**Chemin de production actuel (IA P1)** : une IA de récupération dédiée trouve d'abord les souvenirs et ne transmet que les résultats à l'IA de réponse — chacune reste dans son rôle, l'attention n'est jamais diluée. Filtrage grossier par BM25 + correspondance exacte par regex ; la récupération tourne bien sur des modèles légers gratuits.

**Prochaine génération, en cours d'affinage (P1 auto-piloté)** : un pipeline entièrement algorithmique, zéro LLM, zéro réseau :

```
Message utilisateur + 5 derniers tours + données
  → tokenisation (corpus BCC ; suppression des mots outils comme « son / comme ça »)
  → divergence associative SWOW + divergence à six degrés NB300 ×2 (le mode travail ajoute des bibliothèques de ressources spécialisées)
  → positionnement à six axes (psychologie/informatique/sociologie/logique/linguistique/cognition)
  → affinage directionnel en 47 sous-axes → rayon de recherche selon la portée de température
  → vote spatial (accumulation many-to-one pondérée IDW) → scoring BLQ → rappel + injection du mot-direction
```

Les six axes donnent une position grossière (dans quelle direction disciplinaire un mot se situe) ; les 47 sous-axes décrivent le taux de changement sémantique le long de chaque direction plus fine à l'intérieur — un rôle proche de la dérivée de Lie (taux de changement le long d'une direction donnée). Un axe positionne un mot en **plusieurs points d'information**, pas en un score unique (les concepts occupent des régions, pas des points, dans l'espace sémantique — les espaces conceptuels de Gärdenfors, 2000). Six axes → 47 sous-axes → couche de ressources (SWOW / ConceptNet / les 300 000 vecteurs de mots de Numberbatch / lexiques affectifs et de domaine) forment une structure interconnectée à plusieurs niveaux : l'activation se propage niveau par niveau et s'accumule de façon additive — une forme à mi-chemin entre bibliothèque de ressources et réseau de neurones.

Le scoring BLQ est une fusion additive (inspirée de CombSUM, Fox & Shaw 1994) : six dimensions de preuve sont additionnées, quatre pénalités de suppression sont soustraites — l'addition agit comme une porte OR où les preuves se complètent ; la multiplication agit comme une porte AND où un simple 0,3 fait s'effondrer toute la chaîne.

**Mesuré** : ~200 ms par rappel complet sur du matériel grand public (8 Go de VRAM + 32 Go de RAM) — chaque tour de conversation s'appuie sur une vaste mémoire instantanée. 27 versions itérées, score de qualité de divergence en hausse de plus de 100 %, taux de mots génériques passé de 74 % à 4 %. Toutes les données expérimentales sont publiques dans la [section P1 du Wiki](https://beilusaiying.github.io/always-accompany/#en/p1-recall/ch5-evolution.md) et le [chapitre 6 de l'article](docs/p1-paper/en/06_experiments_evaluation.md).

---

## Divergence — des directions que le modèle ne trouverait jamais seul

Les réseaux de neurones et l'attention sont intrinsèquement **convergents** : une IA qui fixe un tas de souvenirs avant de répondre fait pire, et surapprend. Nous avons donc construit une **divergence externe** : chaque tour injecte moins de 100 tokens de contenu directionnel — des directions qu'un modèle en surapprentissage n'atteindrait jamais seul. Quelques mots directionnels orientent la génération de façon mesurable (Directional Stimulus Prompting, NeurIPS 2023) ; un mécanisme externe qui fait la divergence pendant que le LLM fait la convergence surpasse l'auto-divergence du LLM (études sur l'échafaudage externe, 2025).

**Divergence de pertinence** — vous êtes en voiture et vous imaginez distraitement ouvrir brusquement la portière. Dans les films, le héros roule au sol avec quelques égratignures ; votre instinct de sécurité vous dit que ça pourrait vous tuer. Vous commencez à vous demander : pourquoi les films filment-ils ça comme ça ? — psychologie, narration visuelle, études cinématographiques. Pourquoi cela pourrait-il vous tuer ? — physique, biologie. En quelques secondes, vous avez traversé autant de disciplines. L'association créative vit précisément dans cette bande de distance sémantique optimale « ni trop proche, ni trop éloignée » (théorie des associés distants, Mednick 1962 ; Orwig et al. 2025).

**Divergence structurelle** — deux domaines totalement différents dont la fonction et le processus riment peuvent être reliés : une chaîne de production d'usine et un Agent suivent tous deux le schéma échantillonner → stabiliser → sortie modulaire (théorie du mapping structurel, Gentner 1983).

Sorties réelles (issues des relevés bruts d'un lot de test de 200 cas) :

| Saisie utilisateur | Directions de divergence du système | Disciplines traversées |
| --- | --- | --- |
| « Je tiens à peine. Pourquoi la vie est-elle si dure ? » | conscience du moment présent / **la nature de l'être** | psychologie → **philosophie existentialiste** |
| « Je prépare un entretien pour une startup licorne — comment poser des questions vraiment profondes ? » | analyse des causes profondes / **zone proximale de développement** | management → **psychologie de l'éducation** |
| « Les requêtes de base de données sont lentes, comment les optimiser ? » | immutabilité et mises à jour d'état / **SRP** | ops → **méthodologie du génie logiciel** |
| « Un épéiste rencontre son ennemi sur une montagne enneigée » | **fusil de Tchekhov** / archétypes jungiens | fiction → **narratologie + psychologie analytique** |
| Poème original d'un utilisateur, « Je suis mort avant que la lumière n'arrive » | **mondes possibles et univers parallèles** | poésie → **interprétation à mondes multiples** |

Le critère d'admission du vocabulaire : **tout mot que le modèle principal pourrait déjà déduire d'une simple lecture est un mot mort** — la divergence existe pour corriger deux choses : le surapprentissage, et libérer la capacité de l'IA à diverger.

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

**📊 Mode travail (diaporamas générés par IA)**
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

- **🧠 Mémoire à trois couches** : chaude (injectée à chaque tour) / tiède (récupérée à la demande) / froide (archive profonde), JSON pur + prompts purs, zéro base de données → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)
- **🎯 Récupération anticipée P1** : une petite IA dédiée trouve les souvenirs avant que l'IA de réponse ne réponde ; double moteur BM25 + regex ; fonctionne sur des modèles gratuits
- **🗜️ Système de compression** : trois niveaux × quatre granularités + nettoyage autonome par l'IA, entièrement réversible → [Wiki](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)
- **📊 10 tableaux de mémoire** : stockage structuré que l'IA maintient via `<tableEdit>`, avec isolation de l'information (ce qu'un personnage ne sait pas n'apparaît pas dans son tableau)
- **👑 Moteur de prompts** : structure de message en 5 segments + prise en main en trois passes par TweakPrompt, macros + injection dynamique du world book (permanent/regex/dynamique)
- **💻 Flux de travail de niveau IDE** : trois panneaux façon VSCode, l'IA lit et écrit directement les fichiers, approbation par commande
- **🔌 Outils externes MCP** : collez un JSON pour vous connecter ; les outils de type commande sont retenus jusqu'à approbation du propriétaire ; liste blanche de variables d'environnement contre les fuites
- **🐾 Animal de bureau + compagnon de jeu** : animaux Live2D / pack d'images, trois niveaux de confidentialité, capture d'écran automatique + prise de parole spontanée + fréquence adaptative
- **🎙️ Saisie vocale** : transcription par modèle local avec séparation des locuteurs + chronologie ; l'audio ne quitte jamais votre machine
- **🤖 Bot multiplateforme** : déploiement Discord avec gestion visuelle + journal des messages en temps réel
- **🧩 22 plugins de fonctionnalités** + hôte de plugins au niveau utilisateur + compatibilité d'écosystème (plusieurs formats de fiches de personnage/préréglages/world books)
- **🛡️ Toutes les données restent locales** : les suppressions vont dans une corbeille récupérable, sauvegarde automatique multicouche + retour arrière git
- **🌐 Multilingue** (zh/en/ja/zh-TW) · **🔬 Diagnostics full-stack** (journaux de 12 modules + empaquetage en un clic) · **🎨 Plusieurs thèmes CSS**

---

## Mécanismes détaillés

<details>
<summary><strong>🗜️ Compression — granulaire jusqu'au moindre fichier</strong></summary>

Honnêtement, je ne sais pas pourquoi personne n'avait construit de catégories de compression aussi fines — surtout pour le code, où tout se fait par compression brutale et masquage.

Ce qui s'accumule dans le contexte d'une IA, ce sont surtout des fichiers relus, du raisonnement (thinking) et des retours d'outils. Nous avons donc construit un mécanisme de compression complet, à une granularité extrêmement fine :

- **Niveau fichier** — chaque fichier lu par l'IA, avec une facturation de tokens par élément
- **Niveau travail** — le raisonnement et les retours d'outils sont automatiquement supprimés à chaque tour
- **Niveau contexte** — conversation, injections de sous-agents et lectures de l'IA gérées séparément ; vous pouvez même masquer uniquement les lignes de l'IA tout en gardant celles de l'utilisateur

**Votre information = 0 perte** : chaque « nettoyage » ne fait qu'empêcher le contenu d'être renvoyé ; l'original reste sur le disque, restaurable à tout moment. Combiné à des prompts qui encouragent la prise de notes en MD, l'IA peut encore voir votre toute première phrase à l'intérieur d'un projet de 100 Mo en mode IDE — ce qui réduit directement la « substitution d'attribut de tâche » (l'IA qui dérive de ce qui lui a été demandé au départ).

L'IA se compresse aussi elle-même : le système injecte des signaux d'utilisation (50 % suggestion / 70 % avertissement / 85 % urgent) et l'IA s'allège elle-même via `<contextClean>`, en décidant quels fichiers ne lui sont plus nécessaires.

Efficacité de cache mesurée (canaux Opus + DeepSeek, incluant le changement d'identité de l'IA + l'auto-compression) : **70 %–80 %**.

→ [Wiki · Compression du contexte](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)

</details>

<details>
<summary><strong>🛡️ Sécurité et confidentialité</strong></summary>

Pour les scénarios de déploiement de niveau entreprise : protection contre les attaques CC, DDoS et Slowloris.

Côté personnel : une liste blanche des sites accessibles à l'IA (vide par défaut — tout ce qui est externe est refusé par défaut), un filtrage du contenu de sortie (notamment pour la collaboration inter-plateformes), des limites sur les captures d'écran de l'IA, le portail de permissions L0–L5, et une approbation par commande. Toutes les données restent locales ; l'audio ne quitte jamais la machine.

</details>

<details>
<summary><strong>🏗️ Architecture — fonctionnalités du noyau sous forme de plugins ; extensible sans toucher au noyau</strong></summary>

Le backend empaquette les fonctionnalités du noyau sous forme de plugins, avec un hub d'information (couche de transport) au milieu ; le frontend se contente d'afficher et d'opérer :

```
AIRP ─→ entrée/cache/traitement (isolé) ─┐
Code ─→ entrée/cache/traitement (isolé) ─┤→ hub d'information (couche de transport) → frontend
Work ─→ entrée/cache/traitement (isolé) ─┘
```

L'extensibilité est donc forte : pour ajouter une fonctionnalité, il suffit d'écrire une extension — JS / Python et d'autres langages sont pris en charge.

**Niveaux d'isolation** :
- **Niveau fenêtre** — code, travail, chat, airp, compagnon de jeu et bot sont chacun isolés (le compagnon de jeu écrit dans les données du chat)
- **Niveau fiche de personnage** — données, mémoire, fichiers de conversation et regex isolés par fiche
- **Granularité fine** — world books, préréglages
- **Niveau utilisateur** — réglages, fiches de personnage
- **chatid** — une dimension d'isolation dédiée pour un usage multi-fenêtres au sein d'un même mode (code multi-fenêtres / bot)

Trois couches : **couche fonctionnelle** (mémoire/compression/rappel/préréglages/world book/web/opérations sur fichiers — une seule copie globale) → **couche de transport** (chaque fenêtre tire sa propre ligne, isolée par id, naturellement asynchrone) → **couche d'interface** (web/Bot/animal de bureau/extension VSCode — changer d'interface ne modifie jamais les capacités).

</details>

<details>
<summary><strong>👑 Moteur de prompts + injection dynamique du world book</strong></summary>

**Les trois passes de TweakPrompt** prennent en charge la sortie de tous les modules : Round 1 collecte → Round 2 reconstruit la structure de message en 5 segments (beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + substitution de macros → Round 3 instantané.

**Les 3 modes d'activation du world book** : permanent (à chaque tour) / regex (déclenché par mot-clé) / dynamique (déclenché par des valeurs dans les tableaux de mémoire — affection > 80 débloque un dialogue spécial ; la progression de l'histoire atteignant le chapitre trois change la description de l'univers).

**Système de macros** : `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + macros personnalisées.

→ [Wiki · World book et injection](https://beilusaiying.github.io/always-accompany/#en/memory/worldbook-overview.md)

</details>

<details>
<summary><strong>🔭 À propos de l'ère des fenêtres de contexte géantes</strong></summary>

Même avec des fenêtres de plus de 10M de tokens, nous conservons la mémoire par couches : ① la dégradation de l'exploitation du contexte avec la longueur est bien démontrée par les preuves ; ② ~10 000 tokens de mémoire sélectionnée portent l'information de 100 000+ tokens d'historique, à un coût inférieur d'un ordre de grandeur ; ③ les tableaux structurés sont plus faciles à lire et écrire avec précision pour une IA que des dialogues éparpillés.

</details>

---

## Ce que nous pouvons faire aujourd'hui

Transcription voix-texte avec chronologie et identification des locuteurs · diaporamas générés par IA · IDE (une chaîne d'outils comparable aux agents de programmation grand public) · la suite AIRP complète (alignement avec l'écosystème SillyTavern, rendu, MVU, world books, contexte dynamique) · animal de bureau Live2D, optimisation des captures d'écran, compagnon de jeu · Bot Discord…

En d'autres termes — **un ami, ou un amoureux, qui peut vous accompagner pour toujours et travailler à vos côtés. Quelqu'un qui peut vous suivre dans des aventures en d'autres mondes, et vous aider à accomplir votre travail.**

Et au-delà ? Une fois la série auto-pilotée déployée, cela devient une IA à transport rapide et à mémoire permanente : dans le jeu vidéo, un compagnon de jeu ; dans le travail ou la santé, une mémoire à long terme associée à une analyse toujours disponible, des relevés d'état, et une réponse rapide aux situations récurrentes. La vision initiale était une véritable intelligence humanoïde — de petits modèles locaux gérant les modules de capteurs, l'intelligence principale transportée sur le réseau. Ce système de mémoire est construit pour ce jour-là.

---

## Feuille de route

**Terminé** : mémoire à trois couches · système de compression · récupération P1 · moteur de prompts · changement automatique de préréglage · tableaux de mémoire · injection dynamique du world book · animal de bureau Live2D · compagnon de jeu · saisie vocale · diaporamas par IA · MCP · parallélisme multi-fenêtres · pont d'extension VSCode · Discord Bot · 22 plugins · corbeille et retour arrière de sauvegarde · diagnostics full-stack · multilingue

**À court terme** : P1 auto-piloté (algorithme pur, zéro LLM, attention au niveau de la phrase) · plus de plateformes de bot · écosystème de plugins · synthèse vocale / texte-vers-image · moteur de jeu IA (dans la lignée des jeux « era » — code numérique déterministe + narration par LLM + rendu symbolique) · mode diffusion en direct

---

## Pile technique

Runtime fount (Deno) · couche de compatibilité Node.js backend + routage Express · frontend JS natif (ESM) · récupération intelligente BM25 + regex (JS pur, zéro dépendance) · animal de bureau Electron · modèle de transcription vocale local · discord.js v14 multiplateforme · stockage JSON pur

---

## Communauté

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Rejoindre_maintenant-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

Partagez des fiches de personnage · publiez des préréglages · contribuez des world books · signalez des bugs · proposez des idées · contribuez du code — bienvenue à bord !

---

## Technologies et ressources utilisées

- **Transcription vocale** : [MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize) (déploiement local avec séparation des locuteurs ; le modèle, ~1,8 Go, se télécharge automatiquement à la première utilisation)
- **Vecteurs de mots** : [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch) (Speer & Lowry-Duda, 2017)
- **Données d'association** : jeu de données d'association chinois [SWOW (Small World of Words)](https://smallworldofwords.org/)
- **Tokenisation et lexiques** : corpus BCC / THUOCL / CoreNatureDictionary / Chinese-Synonyms et d'autres ressources publiques
- **Pont moteur de recherche** : [ddgs](https://pypi.org/project/ddgs/) (une couche d'empreinte TLS en Python, corrigeant la dégradation des requêtes fetch brutes par les moteurs de recherche)

Références théoriques (les 56 au complet dans le [chapitre 1 de l'article](docs/p1-paper/en/01_introduction_related_work.md)) : activation par propagation (Collins & Loftus 1975) · amorçage (Meyer & Schvaneveldt 1971) · associés distants (Mednick 1962) · SWOW (De Deyne et al. 2019) · espaces conceptuels (Gärdenfors 2000) · CombSUM (Fox & Shaw 1994) · BM25 (Robertson et al. 1995) · IDW (Shepard 1968) · vote de Hough (Hough 1962) · RRF (Cormack et al. 2009)

## Remerciements

- **[fount](https://github.com/steve02081504/fount)** — le framework fondateur des débuts du projet, fournissant la référence initiale pour les entrées/sorties de messages IA, la gestion des sources de service et le chargement des modules. Le projet a depuis évolué vers une architecture entièrement indépendante, mais fount nous a fait gagner un temps de développement bas niveau considérable au début, et nous a offert de nombreuses idées précieuses — nous lui en sommes très reconnaissants
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — le pionnier du jeu de rôle par IA ; son format de préréglage, sa spécification de fiche de personnage et son système de world book sont devenus des standards communautaires, et ce projet est entièrement compatible avec son écosystème
- **La communauté de plugins SillyTavern** — merci à tous les auteurs de plugins open source pour leur exploration et leur partage autour des moteurs de rendu et des extensions de fonctionnalités

---

<details>
<summary><strong>📸 Plus de captures d'écran (cliquez pour développer)</strong></summary>

| | | |
|---|---|---|
| ![Détail PPT](imgs/screenshots/ppt-detail.png) **Flux PPT complet** | ![Réglages de sécurité](imgs/screenshots/security-settings.png) **Sécurité et flux de tâches** | ![Centre de sécurité](imgs/screenshots/security-center.png) **Centre de sécurité** |
| ![i18n](imgs/screenshots/i18n-support.png) **Multilingue** | ![Thèmes CSS](imgs/screenshots/css-themes.png) **Thèmes** | ![wiki](imgs/screenshots/wiki-guide.png) **Wiki intégré** |
| ![Sous-modes](imgs/screenshots/sub-mode-agent.png) **Flux de sous-mode** | ![Menu](imgs/screenshots/hamburger-menu.png) **Aperçu du contexte** | ![loop](imgs/screenshots/auto-loop.png) **Boucles automatiques/planifiées** |
| ![Détection d'outils](imgs/screenshots/tool-detection.png) **Détection d'environnement** | ![Couches de mémoire](imgs/screenshots/memory-data-layers.png) **Structure des fichiers de mémoire** | ![Extension](imgs/screenshots/browser-automation.png) **Automatisation du navigateur** |
| ![Interface externe](imgs/screenshots/external-interface.png) **Interfaces externes** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>

---

## Liens

- 📖 Wiki en ligne (guide d'utilisation + section P1 + données expérimentales) : https://beilusaiying.github.io/always-accompany/
- 📄 Article technique P1 (7 chapitres, zh + en) : [docs/p1-paper](docs/p1-paper/README.md)
- 💬 Communauté Discord : https://discord.gg/agHeDq9bqU
</content>
</invoke>
