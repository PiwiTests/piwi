# Revue de la documentation Piwi : illustrations manquantes et lacunes

Une revue de toutes les pages du site de documentation (`apps/docs/`), centrée sur les illustrations qui manquent aux utilisateurs et aux nouveaux venus : captures, diagrammes, annotations, boucles vidéo, sorties de commandes. Elle relève aussi les lacunes et les erreurs de contenu trouvées en chemin, et classe les corrections en lots qui peuvent être livrés séparément.

**Status.** Proposé le 2026-10-27, sur `main` au commit `7fc8c44e`. Rien n'est encore réalisé. Chaque lot du §3 peut être livré seul, dans n'importe quel ordre ; une pull request qui en réalise une partie met ce paragraphe à jour.

**Périmètre** : les 115 pages rédigées à la main de `apps/docs/`, plus les 7 pages générées (régénérées localement pour la revue), 80 captures et 12 diagrammes.
**Méthode** : 7 relectures en parallèle (une par groupe de pages), puis une vérification des points les plus importants : rendu réel du site construit, mesures d'échelle des images, lecture du code.

Vocabulaire employé dans ce rapport :

- **scène** : une entrée du script de captures `apps/application/scripts/take-feature-screenshots.mjs`, qui produit une ou plusieurs images de façon reproductible.
- **publier une scène** : passer une scène existante en `tags: ['docs'], out: 'docs'`, pour que son image arrive dans `apps/docs/public/screenshots/`.
- **budget de mots** : la limite de mots par page vérifiée par `apps/application/tests/unit/docs-drift.test.ts` (1 500 mots pour une page de guide, de fonctionnalité ou d'hébergement, 1 000 pour une recette).
- **point de contrôle** : ce que le lecteur doit voir après une étape (sortie de commande, écran, ligne d'état), pour savoir qu'elle a réussi.
- **boucle vidéo** : une vidéo MP4 courte, muette, lue en boucle, comme `demo-live-run.mp4` sur la page d'accueil.

---

## 1. En bref

- **48 pages sur 102 soumises à un budget de mots n'ont aucun visuel.** Sont concernées 12 des 15 pages d'hébergement, toutes les pages de référence et 9 des 12 pages de setup du guide, dont **Getting started**, **Capture fixtures** et **CI**.
- **29 des 72 images placées s'affichent à moins de 55 % de leur taille native, et aucune ne s'agrandit au clic.** Le texte de l'interface y tombe à 5 à 7 px. C'est le cas de toutes les captures d'éditeur et des images clés des tests instables et des preuves d'échec. Sur téléphone, l'échelle descend à 24 %.
- **40 pages sur 102 sont à moins de 25 mots de leur budget, et le décompte inclut le balisage des images.** Une figure coûte 25 à 45 mots (balises, texte alternatif, légende), et les images coûtent 2 839 mots sur l'ensemble du site. En pratique, la règle empêche d'ajouter des illustrations.
- **L'outillage existe mais n'est pas exploité :**
  - le script de captures compte **329 scènes, dont 269 n'écrivent que dans `.screens/`** ;
  - une option d'**annotations numérotées** (`annotate`) existe et **aucune image de la doc ne l'utilise** ;
  - les rendus des artefacts que Piwi renvoie sont des fonctions pures déjà écrites, et la doc n'en montre aucun : commentaire de PR, PR de réparation, plan de correction, ticket Jira.
- **La page des tests instables et la recette correspondante montrent « 0 min » perdue sur chaque ligne** de l'image des tests instables, et le graphique d'historique d'un test est cassé. Plusieurs légendes promettent ce que l'image ne montre pas.
- **Les pages de setup manquent de points de contrôle.** Il n'existe aucune sortie de `init`, du reporter, de `gate`, de `probe`, de `coverage upload` ni de `/api/metrics`.
- **Seules 12 pages de fonctionnalité renvoient vers la démo en ligne**, alors que les données de démonstration couvrent les écrans des clusters, des tests instables, des preuves d'échec, des changements d'un run et des tableaux de bord.

---

## 2. Problèmes transverses

Chacun se corrige une fois et améliore beaucoup de pages.

### 2.1 Captures illisibles à la largeur de la doc

La colonne de contenu fait 688 px. Les scènes de la doc sont capturées à l'échelle 1, sauf `home` et les images de la visite du README, qui sont à l'échelle 2.

| Échelle d'affichage | Images (emplacements) |
|---|---|
| 0,44 à 0,49 | `gather-evidence.png` (2 pages), `flaky-detection.png` (2 pages), les 7 captures VS Code et JetBrains, `tested-elements-overlay.png` |
| 0,53 à 0,54 | `run-timeline.png` (bandeau 688×126), les 7 `picker-*.png` (format des boutiques, 1280×800), `notifications.png`, `bug-report.png`, `flake-lab.png`, `test-functions.png`, `test-selections.png`, `failure-clusters-tab.png`, `saved-dashboard.png`, `dashboard-editor.png`, `assistant-docked.png`, `report-schedules.png` |

Propositions :

1. **Ajouter le zoom au clic** sur les images de contenu, par exemple avec `medium-zoom` monté dans `theme/index.ts`. Effort S. C'est la correction qui couvre le plus d'emplacements.
2. **Recadrer les scènes sur la zone utile** avec `of:`, en `deviceScaleFactor: 2` et avec un `outputWidth` adapté, au lieu de capturer l'écran entier avec la barre latérale. La barre latérale prend 19 à 55 % de plusieurs captures.
3. **Pour les éditeurs**, découper avec `page.screenshot({ clip })`, ou capturer en 1100×700 avec `window.zoomLevel: 1`.
4. **Masquer la version** dans la barre latérale des captures pleine page. Elles affichent v0.56.0 ou v0.59.0, alors que la version actuelle est 0.61.0.

### 2.2 Le budget de mots pénalise les images

Le test de cohérence découpe la page brute sur les espaces (`docs-drift.test.ts:533`). Une `<figure>` avec son texte alternatif et sa légende compte donc 25 à 45 mots. 40 pages ont moins de 25 mots de marge, dont `evidence`, `flaky-tests`, `locator-healing`, `issue-tracking`, `storage`, `ci`, `reporter`, `capture-fixtures`, `extension` et `desktop`.

**Décision à prendre (recommandée)** : exclure du décompte le balisage d'image (`<figure>`, `<img>`, `![…](…)`, attributs et texte alternatif), en gardant éventuellement la `<figcaption>`. Sinon, chaque illustration de ce rapport demande d'abord une coupe. Les relectures ont nommé une coupe candidate pour chaque page concernée (annexe).

### 2.3 Un outillage déjà en place mais inutilisé

- **269 scènes non publiées.** Beaucoup couvrent exactement des écrans que la doc ne fait que décrire. Exemples, tous vérifiés :

  | Page | Scènes à publier |
  |---|---|
  | `guide/getting-started` | `setup-connect`, `home-empty-connect` |
  | `features/quality-reports` | `report-snapshot`, `report-schedule-preview` |
  | `features/timeline-markers` | `run-trend-marker-tooltip`, `markers-panel` |
  | `features/mcp` | `mcp-oauth-consent`, `mcp-tool-details` |
  | `features/agent-skills` | `mcp-agent-skills` |
  | `features/desktop` | `setup-connect-desktop`, `desktop-repro-request` |
  | `features/bug-reports` | `bug-report-spec`, `bug-report-step-shots` |
  | `features/notifications` | `channel-form` |
  | `features/analytics` | `analytics-scope-bar`, `chart-export-menu` |
  | `features/extension-connection` | `project-url-patterns` |
  | `features/replay-a-bug-report`, `features/offline-export` | `execution-replay-export` |
  | `features/failure-clusters` | `cluster-activity` |

  Les relectures en citent aussi d'autres, non revérifiées une à une :
  - côté administration : `storage-analysis`, `localization-settings`, `setup-ladder-declined`, `user-api-keys`, `settings-user-project-roles` ;
  - côté fonctionnalités : `flakiness-tab`, `flake-lab-tab`, `quarantine-dismiss`, `run-resources`, `run-timeline-resources`, `page-diff`, `attempt-diff`, `assistant-proposal`, `guides`, `locator-usage-drawer`, `project-locators`, `test-search`, `failure-headline`, `evidence-fixtures-footer`, `open-in-ide-settings`, `extension-connect`.

  Publier une scène ne demande qu'un changement de tags, plus éventuellement un recadrage.
- **Annotations numérotées.** `scripts/screenshot-annotations.mjs` dessine des étapes numérotées, des encadrés et des flèches, et produit une variante `-annotated.png`. Aucune scène ne l'utilise. C'est l'outil adapté aux écrans denses : bloc de situation d'un échec, page d'un cluster, panneau de réparation de locator, diagnostic IA, timeline d'un run.
- **Rendus purs des artefacts renvoyés par Piwi**, jamais montrés dans la doc :

  | Artefact | Fonction de rendu |
  |---|---|
  | Commentaire de PR | `buildPrComment` |
  | PR de réparation | `buildHealPrBody` |
  | Plan de correction en Markdown | `fixPlanToMarkdown` |
  | Squelette de test pour un trou de scénario | `renderScenarioDraft` |
  | Commentaires Jira automatiques | `policy-comments.ts` |
  | E-mails | `renderRunNotificationEmail`, `renderNewClusterEmail`, `renderDigestEmail` |
  | Carte Teams | `teamsEventMessage` |

  Le modèle `prCommentPage()` du script de captures ne sert qu'à une scène. Sous forme de bloc de code, ces rendus atteignent aussi les agents, via l'outil MCP `describe_piwi`.
- **Vidéo.** `scripts/record-demo-video.mjs` sait déjà passer du WebM au MP4. En le transformant en utilitaire partagé, on peut produire des boucles vidéo pour les interactions qu'une image fixe ne rend pas : pointage d'un élément, rejeu d'un rapport de bug, enregistrement, pas à pas dans l'éditeur.

### 2.4 Pas de points de contrôle « ce que vous devez voir »

Aucune page de setup ne montre la sortie attendue d'une étape. Le cas le plus coûteux est la ligne `Not enabled … set PIWI_DASHBOARD_URL or serverUrl to enable.` du reporter : c'est ce que tape un débutant bloqué, et aucune page ne la cite. Propositions :

- **Blocs de texte réels**, générés depuis les vrais formateurs et vérifiés par un test unitaire, sur le modèle de `tests/unit/setup-snippets.test.ts` :

  | Sortie | Formateur |
  |---|---|
  | `init` (marques `+ ~ = ! - x`) | `formatStep` |
  | Reporter pendant un run | |
  | `piwi gate` | `formatGateResult` |
  | `coverage upload` | `formatSummary` |
  | `piwi run impact`, `piwi probe` | |
  | `/api/metrics` | fixtures de `open-metrics.test.ts` |

  Ces blocs sont indexés par la recherche, lisibles par les agents, et ne demandent aucune image.
- **Utiliser la page Setup comme vérification.** `shared/capabilities.ts` y détecte les fixtures de capture, les logs serveur, le SCM, l'IA et la couverture, mais aucune page de setup ne le dit.

### 2.5 Mise en forme incohérente

- **Trois balisages d'image coexistent.**
  - `<figure>` : 44 pages, avec cadre et légende.
  - `<div class="doc-screenshot">` : 4 pages (`issue-tracking`, `issue-automation`, `operate/integrations`, `operate/project-access`). **Cette classe n'a aucun style** : pas de cadre, pas de légende. En thème sombre, la fenêtre « Create issue » s'affiche comme un bloc blanc de 964 px de haut.
  - `![…](…)` : 5 pages (`analytics`, `assistant`, `dashboards`, `environment-incidents`, `quality-reports`), sans cadre ni légende.

  Proposition : un seul format, soit `<figure>` partout, soit un composant `<Screenshot>` qui ajoute le zoom, `loading="lazy"`, la largeur et la hauteur. Un nouveau composant demande aussi un rendu texte dans `docs-corpus.ts`.
- **7 diagrammes sur 12 n'ont pas de variante sombre** et s'affichent comme des cadres clairs en thème sombre : `piwi-ecosystem`, `failure-loop`, `failure-clustering-fingerprint`, `failure-clustering-semantic-merge`, `locator-healing-capture`, `locator-healing-resolution`, `demo-in-browser`. C'est contraire à la règle « theme-aware » du guide de la doc. De plus, tous ont un `viewBox` de 920 px avec un texte de 10,5 à 11 px, soit environ 8 px à l'écran.
- **Thèmes mélangés.**
  - Captures du dashboard plutôt claires ; trois sombres sans raison apparente : `ai-diagnosis`, `gather-evidence`, `run-timeline`.
  - Captures d'éditeur toutes sombres.
- **PNG uniquement** : 11 Mo au total, sans `width` ni `height`, donc avec un décalage de mise en page au chargement. Passer en WebP diviserait le poids par environ 3 (gain secondaire).

### 2.6 Des données de démonstration qui contredisent les légendes

- **`flaky-tests.png` et `flaky-detection.png`.** Chaque ligne affiche « 0 min » avec un point vert, et le premier test affiche « 0% fail ». Les légendes promettent un classement par minutes de CI perdues, et la recette dit que « quelques lignes rouges font l'essentiel du total ». Il faudrait des minutes perdues dans les données de démonstration.
- **`failure-clusters-tab.png`** montre 2 clusters de 1 et 2 tests, sous la légende « quarante tests rouges deviennent trois causes ».
- **Cas limites dans des images de référence** :
  - la bannière « backend restarted » sur `coverage-file.png` et `combined-coverage-file.png` ;
  - l'avertissement `PIWI_SITE_URL` et une liaison Jira vide sur les captures de `issue-tracking` ;
  - l'état vide sur `integrations-settings.png`, dont le texte alternatif décrit une connexion vérifiée ;
  - le badge « **Trial** » de la licence d'essai JetBrains dans la barre d'état des deux captures JetBrains (vérifié).

### 2.7 Liens vers la démo en ligne

La section `## Try it in the demo` existe sur 12 pages seulement : `ai-diagnosis`, `flake-lab`, `coverage-insights`, `combined-coverage`, `code-reach`, `server-coverage`, `scenario-gaps`, `resource-leaks`, `probes`, `issue-tracking`, `environment-incidents` et `cpu-memory-disk`.

Elle manque sur des pages dont l'écran est présent dans les données de démonstration :
- historique et échecs : `evidence` (exécution 37), `failure-clusters` (cluster 10), `flaky-tests` (cas de test 9), `run-changes` (run 2), `slow-tests` ;
- autres fonctionnalités : `locator-healing`, `analytics`, `dashboards`, `guides`, `assistant` ;
- guide : `first-failure`, `backend-logs`.

C'est l'illustration la moins chère qui soit : une entrée dans `shared/demo/demo-examples.mjs`. Le vocabulaire `expect` de ce registre est fermé, donc certaines pages demandent d'abord une clé (tableau de bord, rapport de bug, marqueur).

### 2.8 Images sans page

| Image | Où la placer |
|---|---|
| `project-detail.png` | `features/timeline-markers` (tendance des runs avec les marqueurs), sans autre travail |
| `ai-usage.png` | `guide/ai-provider`, section « Usage and quality » |
| `vscode-run-control-hover.png` | remplace `vscode-run-control.png` sur `editor-run-control` : même arrêt, contrôles lisibles en 14 px (vérifié) |
| `vscode-run-control-paused-page.png` | `editor-run-control`, section « A headless run » |
| `performance.png` | `timeline-markers` ou `slow-tests` |
| `projects.png` | utilisée nulle part, ni dans la doc ni dans le README |
| `jetbrains-heal.png`, `vscode-hover.png` | utilisées seulement dans le README de chaque extension ; à placer sur `jetbrains` et `editor-failures` |

`vscode-hover.png` doit d'abord être recapturée : elle ne montre pas la capture d'échec promise.

`npm run app:screens:check` ne détecte pas une image qu'aucune page n'utilise : il ne vérifie que la correspondance entre scènes et images.

---

## 3. Plan d'action recommandé

Les lots sont classés par rapport gain sur effort. Chaque lot peut faire l'objet d'une PR séparée.

### Lot 1 : socle (effort S à M, effet sur tout le site)

1. Ajouter le zoom au clic sur les images de contenu.
2. Trancher la règle du budget de mots pour le balisage d'image (§2.2), puis adapter `docs-drift.test.ts`.
3. Utiliser un seul format d'image : supprimer `doc-screenshot` et les `![]()` restants.
4. Ajouter une variante sombre aux 7 diagrammes clairs et augmenter la taille du texte.
5. Vérifier dans le test de cohérence que chaque image de `public/screenshots/` est utilisée, et que chaque page a son `## Related` (7 pages n'en ont pas, §5).

### Lot 2 : gains immédiats (effort S, sans nouvelle scène)

1. Placer les images sans page (§2.8).
2. Remplacer les images fausses ou cassées :
   - `test-case-detail.png` : seules les barres en échec s'affichent et il n'y a pas de bande de statuts. Recapturer, ou utiliser `tour-test-history.png`.
   - `flaky-detection.png` et `flaky-tests.png` : données et recadrage.
   - `gather-evidence.png` sur `evidence` : utiliser la carte des preuves seule.
   - `integrations-settings.png` : capturer l'état connecté.
   - `vscode-hover.png` : recapturer avec la capture d'échec.
3. Publier les scènes existantes listées au §2.3, page par page.
4. Ajouter les sections `## Try it in the demo` manquantes (§2.7).

### Lot 3 : points de contrôle et artefacts en texte (effort S à M)

1. **Sorties de commandes** générées et testées : `init`, reporter (avec `Not enabled`), `gate`, `coverage upload`, `run impact`, `probe`, `/api/metrics`.
2. **Artefacts renvoyés**, en image via `prCommentPage()` ou en bloc de code :
   - le commentaire de PR complet ;
   - la PR de réparation ;
   - le plan de correction en Markdown ;
   - le corps du ticket Jira ;
   - le squelette de test d'un trou de scénario ;
   - le fichier d'un AI step ;
   - le code avant et après sur `recorded-code` et `test-functions`.
3. **Aperçus des notifications reçues** : e-mail (rendu existant, S), puis Teams et Slack (M).

### Lot 4 : nouveaux diagrammes (effort M chacun, SVG avec thème clair et sombre)

Par ordre de priorité :

1. **« Les pièces en jeu »** sur `getting-started` : reporter → envoi → serveur (base de données, artefacts dans `.data` ou S3) → navigateur, avec une ligne CI.
2. **Topologie de production** sur `operate/deployment`, réutilisée avec des numéros d'étape sur `production-checklist`.
3. **Modèle de données en grille** sur `concepts` : runs en colonnes, cas de test en lignes, exécutions dans les cases, un cluster qui traverse les deux. Il remplace l'arborescence ASCII, trompeuse : elle range le cluster sous le cas de test.
4. **Échelle de choix de la baseline** sur `run-changes`, réutilisée sur `branches` et `concepts`. La règle est réécrite en prose sur plus de 5 pages.
5. **Calcul du score d'instabilité, exemple chiffré** sur `flaky-tests` (10 runs → score 30, formule d'impact).
6. **Architecture des extensions d'éditeur et page d'entrée** « quelle page lire » sur `editors`. Ajouter l'échelle de choix de l'instance sur `editor-connection`.
7. **Flux MCP** sur `mcp` : OAuth ou clé `pd_`, modules, rôles, journal des écritures. Ajouter une transcription réelle d'un échange agent ↔ outils.
8. **Mise à jour et retour arrière** sur `operate/upgrading`, réutilisé sur `backup-restore`.
9. Ensuite :
   - les états d'un rapport de bug (`bug-reports`) ;
   - la négociation de connexion de l'extension (`extension-connection`) ;
   - la fusion des shards (`ci`) ;
   - le flux des données vers l'extérieur (`privacy`) ;
   - la matrice SQLite ou PostgreSQL × disque local ou S3 (`database`) ;
   - le tableau « quelle couverture demande quoi » sur `reference/coverage-cost` (qui n'a pas de budget), relié depuis chaque page de couverture.

### Lot 5 : boucles vidéo (M une fois pour l'utilitaire partagé, puis S à M par boucle)

Par ordre de priorité :

1. `pick-an-element` : survol, accroche, parcours de l'arbre, clic.
2. `replay-a-bug-report` : le curseur qui rejoue, puis le verdict.
3. `record-actions` et `report-a-bug`.
4. `editor-recording` : demande une capture Xvfb de deux fenêtres, donc une nouvelle chaîne de production (effort L). En attendant, une image fixe de l'éditeur pendant l'enregistrement (M).

---

## 4. Les propositions P1 les plus rentables

P1 signifie : un débutant risque d'être bloqué ou induit en erreur sans cette illustration, ou une page clé n'a aucun visuel.

| # | Page | Proposition | Comment | Effort |
|---|---|---|---|---|
| 1 | tout le site | Zoom au clic | `medium-zoom` dans le thème | S |
| 2 | tout le site | Exclure le balisage d'image du budget de mots | `docs-drift.test.ts` | S |
| 3 | `guide/getting-started` | Assistant de connexion, ligne d'état « Waiting / A run is reporting now », sortie de `init` et du reporter (dont `Not enabled`) | scènes `setup-connect`, `home-empty-connect` et blocs de texte | S |
| 4 | `guide/getting-started` | Diagramme « les pièces en jeu » | nouveau SVG | M |
| 5 | `guide/first-failure` | Bloc de situation recadré et annoté de 1 à 5 selon les sections de la page, à la place de la capture pleine page sombre (échelle 0,44) ; aligner le texte cité sur l'image | scène `failure-headline` et `annotate` | S |
| 6 | `guide/capture-fixtures` | Diff de l'import (`@playwright/test` → `./fixtures`), puis carte des preuves avant et après | bloc `diff`, scène `evidence-fixtures-footer` | S à M |
| 7 | `guide/concepts` | Modèle de données en grille | nouveau SVG | M |
| 8 | `features/flaky-tests` | Score d'instabilité chiffré, onglet Flakiness, image corrigée | SVG et scène `flakiness-tab` | S à M |
| 9 | `features/evidence` | Onglet Screen en vue Page diff et carte des preuves seule en échelle 2 | scènes `page-diff` et `of:` | S |
| 10 | `features/failure-clusters` | Boîte de réception des échecs sur Home et page d'un cluster annotée | nouvelle scène et `cluster-clarity` avec `annotate` | M |
| 11 | `features/slow-tests` | Devenir la page de la timeline d'un run : image annotée, puis reprise des 277 mots de `ui-overview` et de la définition du temps perdu de la recette | `annotate` sur `run-timeline` | M |
| 12 | `features/pr-feedback` | Commentaire de PR complet | `buildPrComment` et `prCommentPage()` | S |
| 13 | `features/auto-heal` | PR de réparation rendue et écran des réglages | `buildHealPrBody` et nouvelle scène | S |
| 14 | `features/locator-healing` | Corriger `locator-healing-resolution.svg` : il manque l'étape « Diff rename » en premier, le panneau s'appelle « Locator fix » | modifier le SVG | S |
| 15 | `features/code-reach` | Montrer la couverture **navigateur** : les deux images actuelles montrent des fichiers C# serveur | nouvelle scène | M |
| 16 | `features/quality-reports` | Le rapport produit et l'e-mail envoyé | scènes `report-snapshot` et `report-schedule-preview` | S |
| 17 | `features/notifications` | « Ce que vous recevez » : e-mail, Teams, Slack | rendus existants, nouveau script | M |
| 18 | `features/timeline-markers` | Marqueurs sur la tendance des runs | `project-detail.png`, sans autre travail | 0 |
| 19 | `features/editor-run-control` | Image lisible et cas « headless » | les deux images `vscode-run-control-*` sans page | S |
| 20 | `features/editors`, `features/editor-connection` | Architecture, page d'entrée, états de connexion et tableau des messages d'erreur réels de `packages/editor/src/context.ts` | SVG, scènes VS Code | M |
| 21 | `features/mcp`, `features/agent-skills` | Diagramme de flux, transcription réelle, boucle de retour des agents | SVG et bloc de code | M |
| 22 | `features/desktop` | Premier lancement (assistant sans URL), « Run locally » et la zone des runs locaux | `setup-connect-desktop`, nouvelle scène | S à M |
| 23 | `features/recorded-code`, `features/test-functions` | Code avant et après, produit par `piwi codegen` | bloc de code | S |
| 24 | `operate/deployment` | Topologie de production et vérification `/api/health` | SVG et bloc de texte | M |
| 25 | `operate/authentication` | Écran du premier administrateur (jeton de setup) et écran de connexion | nouvelle scène avec `page.route` | M |
| 26 | `operate/capabilities`, `operate/api-keys`, `operate/metrics` | Page Setup, gestion des clés, exemple de sortie OpenMetrics | `setup-ladder-declined`, `user-api-keys`, bloc de texte | S |
| 27 | `operate/upgrading` | Mise à jour et retour arrière | SVG | M |
| 28 | `features/pick-an-element`, `features/replay-a-bug-report` | Boucles vidéo | utilitaire vidéo partagé | M |

---

## 5. Erreurs et contradictions à corriger, indépendamment des visuels

### Vérifiées

- **Version de Playwright.**
  - Le reporter exige `@playwright/test ^1.64.1` (`packages/reporter/package.json`), et aucune page ne donne la version prise en charge.
  - `guide/ci.md:50` épingle l'image `v1.61.1-noble` « at or above the reporter's peer range », ce qui est faux.
  - `guide/reporter.md` (lignes 21, 35, 59) décrit encore des conditions « before 1.63 ».
- **`guide/importing-runs.md`** : la description (l'extrait de recherche) annonce l'import des « Playwright JSON and blob reports ». Ligne 37, la page dit que la sortie JSON n'est pas importable.
- **`operate/backup-restore.md` ne cite jamais `PIWI_SECRET_KEY`.** Les clés d'IA, les jetons SCM et Jira et les secrets de webhook sont chiffrés avec elle, donc une restauration sur un nouvel hôte les perd.
- **`operate/production-checklist.md`** ne cite ni `PIWI_SETUP_TOKEN` ni `PIWI_SITE_URL`. Sans jeton de setup, quiconque atteint l'URL entre l'activation de l'authentification et la création de l'administrateur peut devenir administrateur.
- **`reference/cli.md`.**
  - `coverage` manque dans le tableau des commandes, alors que sa section existe.
  - Ligne 56, `--skills` annonce « the four workflow skills », alors que `WORKFLOW_SKILLS` en contient 6.
- **`reference/notification-events.md`** ne donne pas le format de la signature (`X-Piwi-Signature: sha256=<hex>`, aucune occurrence de « sha256 » sur la page). Elle ne dit pas non plus comment la vérifier.
- **`features/auto-heal.md`** : la description dit « locator replacement or patch », alors que la page dit qu'aucun code généré n'est écrit.
- **`guide/ci.md:43`** : « The shallow clone `actions/checkout` makes is fine ». Or `piwi run impact` et `preflight --base` font un `git diff` local ; sur un clone superficiel, ils retombent en silence sur la suite complète.
- **`apps/application/shared/piwi-features.ts:221`** : l'assistant a `where: 'API reference → Assistant'`. Le panneau s'ouvre en réalité depuis « Ask Piwi », `Ctrl+I` ou la palette.
- **7 pages sans `## Related`**, pourtant obligatoire : `features/quality-reports`, `features/editor-connection`, `features/locator-usage`, `features/auto-heal`, `operate/tracing`, `reference/steps-format`, `reference/coverage-cost`.
- **Formulations interdites de travail à venir** :
  - `features/ai-steps.md:62` et `:132` (« not available yet ») ;
  - `features/server-coverage.md:106` ;
  - `features/branches.md:56` ;
  - `features/extension.md:138` (« No aria-snapshot copier yet ») ;
  - `operate/one-click-deploy.md:41` (« No button yet »).
- **Comptes erronés.**
  - `features/quality-reports.md:20` annonce « two built-in dashboards », puis en liste quatre.
  - `features/replay-a-bug-report.md:37` annonce « one of three answers », puis en liste quatre.
- **Images qui contredisent leur page.**
  - `test-case-detail.png` (2 pages) : seules les barres en échec s'affichent ; les exécutions réussies, autour de 4,5 s, sont sous le bas de l'axe. Il n'y a pas de bande de statuts, et les cartes du bas sont vides.
  - `flaky-detection.png` : « 0 min » partout.
  - `vscode-hover.png` : pas de capture d'échec.
  - Les captures JetBrains portent le badge « Trial ».

### Signalées par les relectures, non revérifiées

- **`operate/deployment`, manifeste Kubernetes.**
  - Il n'y a pas de `fsGroup: 1001` : le volume risque de ne pas être accessible en écriture.
  - `Service` de type `LoadBalancer` en HTTP, qui expose une instance sans authentification.
  - Il n'y a pas d'`envFrom` pour le ConfigMap et le Secret que le générateur produit.
  - `:latest` partout, alors que la page dit d'épingler une version.
- **`operate/deployment`, autres points.**
  - La page affirme que la référence dit pour chaque variable si les réglages de l'interface peuvent la remplacer. Cette colonne n'existe pas.
  - En `npx` sur le réseau local, la connexion échoue en HTTP (cookie `Secure`), ce que la page ne dit pas.
- **`operate/one-click-deploy`** : Railway est noté « Button » dans le tableau et « No button yet » dans la section.
- **`operate/authentication`.**
  - Mot de passe oublié, invitations et vérification d'adresse demandent SMTP : sans SMTP, la réinitialisation répond 200 sans rien envoyer.
  - Il n'existe pas de réinitialisation par un administrateur, donc pas de procédure si le dernier administrateur perd son mot de passe.
  - Le parcours d'invitation n'est pas documenté.
  - Seuls Google et GitHub sont pris en charge, sans OIDC générique ; la page ne le dit pas.
- **`operate/capabilities`** dit que décliner une capacité est réservé à l'administrateur, mais le `PATCH` par projet demande `project:manage`.
- **`operate/api-keys`.**
  - Elle montre une entrée `reporter` nue avec `apiKey`, alors que le reporter lit `PIWI_API_KEY` dans l'environnement et que la règle est de commencer par `wrapConfig`.
  - Elle utilise un `curl` avec `\`.
- **`operate/metrics`** : la configuration Prometheus n'a pas `scheme: https`.
- **`operate/integrations`** : « Jira Cloud est le tracker pris en charge » contre « including a self-hosted host ».
- **`reference/configuration`, générateur de page.**
  - Il ignore les métadonnées `secret`, `requiredWhen`, `relevantWhen`, `enum` et `min`/`max`.
  - Les variables `OTEL_*` sont absentes du registre.
  - `PIWI_SMTP_SECURE` se contredit (« default false » contre « on when port 465 »).
  - Le générateur de configuration émet `:latest` quelle que soit la version choisie.
- **`features/dashboards`** omet le tableau de bord intégré « Team ».
- **`features/editor-coverage`** limite les marques par ligne côté serveur à ASP.NET Core, alors que Nitro les fournit aussi.
- **`features/editor-failures`** : le libellé « Baseline » de l'éditeur, qui désigne le dernier run complet, contredit `concepts` (le dernier run vert).
- **`features/devtools`** : l'exemple en texte et la capture montrent deux éléments différents.
- **`features/test-functions`** : la capture montre le badge `scanned`, que seules les données de démonstration produisent.
- **`features/report-a-bug` et `features/bug-reports`** : les montants d'exemple diffèrent d'une page à l'autre et avec la capture.
- **`guide/first-failure`** : le titre, la ligne d'identité et les numéros de run cités diffèrent de la capture. L'onglet **Locators** n'est pas listé, et l'ordre d'ouverture des onglets contredit `evidence`.
- **`guide/getting-started`.**
  - `init` écrit toujours `tests/fixtures.ts`, quel que soit `testDir`, ce qui est peut-être un bug d'`init`.
  - Les runs partiels et ceux des branches de fonctionnalité sont masqués par défaut, ce qu'aucune page ne dit.
- **`reference/gap-detectors`.** Les identifiants des détecteurs (`success-only`, …), affichés dans l'onglet Gaps, sont absents. La confiance de chaque détecteur n'est pas donnée, donc les scores de l'interface (0,178, 0,070) ne peuvent pas être recalculés.
- **`reference/mcp-tools`** : les paramètres des outils ne sont pas listés, alors que `toolParameters()` les renvoie déjà.
- **Lien de capacité** : dans `shared/capabilities.ts`, `flake-lab` pointe vers `features/flaky-tests`.
- **Étiquettes d'instance** (Settings → Tags) : aucune page.

---

## 6. Bugs et dette technique repérés en chemin

- **Vérifié** : `apps/application/shared/heal-pr.ts:15`. `sourceLabel()` n'a pas de cas `diff-rename`. La colonne « From » d'une PR de réparation affiche donc la valeur brute `diff-rename`.
- **Vérifié** : des détecteurs de trous de scénario sont exportés et testés mais jamais appelés en production, par exemple `detectMatrix`, `detectPhantomCoverage` et `detectIncidentalCatch` dans `shared/handlers/scenario-gaps.ts`. La relecture en compte 7, plus `detectEscapedDefect`, que remplace `detectReportedBugEscapes`.
- **Vérifié** : la chaîne de captures JetBrains tourne avec une licence d'essai, d'où le badge « Trial », aussi visible sur la fiche Marketplace.
- **À vérifier** : JetBrains Code Vision n'affiche que « Trace » au-dessus de la ligne en échec. `PiwiCodeVisionProvider.kt` émet plusieurs entrées sous un même identifiant de fournisseur ; l'IDE garde peut-être seulement la dernière.
- **À vérifier** : la scène `vscode-hover` ignore l'expiration de l'attente de l'image (`.catch(() => {})`). C'est ainsi que la capture est sortie sans image.
- **À vérifier** : le graphique « Duration trend » de `test-case-detail.png` ne dessine pas les barres sous le minimum de l'axe. `tour-test-history.png`, capturée plus tard, est correcte, donc il s'agit peut-être d'un artefact de capture.

---

## 7. Annexe : détail par page

Les visuels proposés sont notés P1, P2 ou P3, avec l'effort S, M ou L. Le nombre entre parenthèses est la marge restante sous le budget de mots, quand elle est faible.

### Guide

**index.md**
- Visuels : P3, recadrer les images « Failure clusters » et « Flaky » sur leur liste. Les deux montrent le même en-tête de projet sur 55 % de l'image (S, et M avec des données plus riches).
- Lacunes :
  - L'étape 2 ne dit pas qu'il faut importer `test` depuis le fichier de fixtures.
  - L'étape 3 suppose un test rouge, sans solution pour une suite verte (démo ou application d'exemple).

**guide/getting-started.md** (0 visuel, environ 650 mots de marge)
- P1 :
  - diagramme « les pièces en jeu » (M) ;
  - assistant de connexion et ligne d'état comme point de contrôle (S) ;
  - sortie de `init` (S) ;
  - sortie du reporter, avec la ligne `Not enabled` (S).
- P2 : la vidéo `demo-live-run.mp4` après « Open it ».
- Lacunes :
  - la version de Playwright prise en charge ;
  - l'emplacement du fichier de fixtures et le chemin relatif depuis un sous-dossier ;
  - aucune aide quand rien n'apparaît : `Not enabled`, conteneur lié à `127.0.0.1` injoignable depuis WSL ou un conteneur de développement, authentification sans clé ;
  - les runs partiels et de branche sont masqués par défaut ;
  - le projet est créé au premier run.

**guide/what-piwi-does.md**
- Visuels : rien de nouveau.
- Les deux SVG n'ont pas de thème sombre et leur texte s'affiche autour de 8 px.
- Lacune : « l'IA demande votre clé » ignore les fournisseurs en ligne de commande (Claude Code, Codex, DeepSeek), qui n'en demandent pas.

**guide/first-failure.md** (2)
- P1 : bloc de situation annoté, en thème clair et en échelle 2 (S).
- P2 : lien vers la démo, en coupant « You're not reading it alone ».
- P3 : boucle vidéo du clic sur une citation.
- Le texte cité diffère de la capture (§5).

**guide/concepts.md** (référence, sans budget)
- P1 : grille du modèle de données.
- P2 :
  - échelle de la baseline ;
  - `failure-clustering-fingerprint.svg` sous « Error fingerprint » ;
  - bloc de situation annoté (Situation, Story, Next step, Cluster state).
- Lacunes :
  - la différence entre projet Piwi et projet Playwright n'est jamais expliquée ;
  - il manque des entrées pour le statut d'un run, run complet ou partiel, Quarantine, editor service, run channel et stop.

**guide/comparison.md**
- Rien de nouveau.
- Lacunes : la version de Playwright ; l'application de bureau pour le cas « débogage local seulement ».

**guide/license.md** : rien.

**guide/privacy.md** (1)
- P2 : diagramme du périmètre réseau et des 8 destinations sortantes, en déplaçant la partie Piwi Picker (210 mots) vers `bug-reports`.
- Lacune : ce que le reporter envoie au serveur ; lien vers `reference/test-metadata`.

**guide/reporter.md** (1)
- P2 :
  - arbre de décision « où va ce run » (URL, environnement, `.env`, application de bureau) ;
  - séquence du cycle de vie d'un run ;
  - bloc de sortie du reporter.
- Lacunes :
  - les conditions « before 1.63 » sont sans objet avec la plage `^1.64.1` ;
  - les lignes du reporter que l'on recherche ne sont pas citées : `Not enabled`, `Using the desktop app…`, `Partial run detected` ;
  - `video: 'retain-on-failure'` n'est pas expliqué.

**guide/capture-fixtures.md** (3)
- P1 : bloc `diff` de l'import.
- P2 : carte des preuves avant et après, en déplaçant « Green page sampling » (140 mots) vers `evidence`.
- Lacunes :
  - l'emplacement du fichier ;
  - le point de contrôle (la capacité détectée sur la page Setup, la mention qui disparaît du pied de la carte des preuves).

**guide/ci.md** (0)
- P2 :
  - diagramme de fusion des shards ;
  - sortie de `piwi gate`, en remplaçant le tableau des règles par un lien vers `reference/cli#gate` (150 mots).
- Lacunes :
  - l'image `v1.61.1` ;
  - le clone superficiel ;
  - la ligne `Not enabled` absente du dépannage.

**guide/source-control.md**
- P2 : Project → Settings → Source control (scène `project-settings`), puis la ligne et la carte « What changed » (scène `cluster-suspect-lines`).
- Lacunes :
  - les liens vers la création d'un jeton chez chaque hébergeur ;
  - la vérification par la page Setup.

**guide/ai-provider.md** (3)
- P2 :
  - `ai-usage.png` ;
  - Settings → AI → Model providers ;
  - tableau de choix d'un fournisseur.
- Déplacer le paragraphe Claude Code CLI (230 mots) vers sa propre page, comme pour Codex et DeepSeek.
- Lacune : aucun point de contrôle pour le premier diagnostic.

**guide/codex-cli.md, guide/deepseek-cli.md**
- Rien d'indispensable.
- Lacunes :
  - l'utilisation avec l'image Docker (le binaire et sa connexion dans le conteneur) ;
  - le dépannage de « Recheck ».

**guide/backend-logs.md** (0)
- P1/P2 : onglet Network d'une exécution avec ses logs serveur, avec un lien vers la démo.
- P2 : diagramme de séquence de l'en-tête `X-Piwi-Logs`.
- Lacune : pas d'étape de vérification (en-tête `X-Piwi-Logs`, `/__piwi/manifest`, page Setup).

**guide/importing-runs.md** (1)
- P2 : page d'import avec 4 archives dans 4 états, à la place du tableau.
- Lacunes :
  - la description contredit la page ;
  - pas d'étape pour un lecteur qui n'a encore aucun projet.

### Fonctionnalités : garder l'historique

**features/ui-overview.md** (0)
- P2 : carte SVG de la navigation, à la place de `home.png`, seule capture d'une page qui les interdit.
- Lacunes :
  - l'onglet Resources d'un run ;
  - la liste « Active » de la barre latérale ;
  - les onglets d'un cas de test.
- Déplacer les 277 mots de la timeline vers `slow-tests`.

**features/guides.md**
- P1 : une étape de guide (scène `guides`, image `guides-stop.png`).
- P2 : la palette et une suggestion « Show me ».
- Lacunes :
  - la différence avec la visite guidée de la démo ;
  - `<Needs reporter />` est trompeur, puisqu'un guide sert justement à installer le reporter.

**features/branches.md**
- P1 : échelle de la baseline.
- P2 : filtre de branche ouvert (scène `project-header`).
- Lacunes :
  - où voir la branche enregistrée pour un run ;
  - une formulation de travail à venir et une formulation historique.

**features/run-changes.md**
- P1 : échelle de la baseline.
- P2 :
  - `run-changes.png` annotée ;
  - sélecteur de run (scène `run-changes-fallback`).
- L'image n'a pas la section « Fixed » que promettent le texte alternatif et la légende.
- Il n'y a pas de lien vers la démo.

**features/offline-export.md**
- P2 :
  - menu Export (scène `execution-replay-export`) ;
  - rapport HTML exporté, tel que le destinataire le voit.
- P3 : correspondance dans Perfetto.
- Lacune : la formulation « on the roadmap ».

**features/share-links.md**
- P2 : fenêtre de partage avec un lien tout juste créé (scène `report-share-link`).
- Lacune : le comportement quand `PIWI_SHARE_LINKS_ENABLED` est désactivé.

### Fonctionnalités : expliquer les échecs

**features/evidence.md** (0)
- P1 : onglet Screen en vue Page diff, et carte des preuves seule à la place de `gather-evidence.png`.
- P2 : liste des différences entre tentatives (scène `attempt-diff`).
- `test-case-detail.png` est cassée.
- Lacunes :
  - l'onglet Locators n'est pas mentionné ;
  - il n'y a pas de `<Needs fixtures />` ;
  - il n'y a pas de lien vers la démo.

**features/failure-clusters.md** (3)
- P1 : boîte de réception des échecs, et page d'un cluster annotée.
- P3 : boucle vidéo du tri au clavier.
- Lacunes :
  - pas de lien vers les incidents d'environnement ;
  - pas de lien vers la démo (cluster 10).

**features/environment-incidents.md**
- Rien d'indispensable.
- Passer `![]()` en `<figure>`.
- Le lien depuis `mass-failure` manque.

**features/flaky-tests.md** (1)
- P1 : score chiffré, onglet Flakiness, image corrigée.
- P2 : vue Quarantine.
- Lacunes :
  - les seuils et la formule d'impact ;
  - « pipeline-block effect » n'est pas défini.

**features/flake-lab.md** (3)
- P2 : boucle « suspects → piwi flake → verdict → verify », et la scène `flake-lab-tab` à la place de la capture pleine page.

**features/slow-tests.md**
- P1 : section « The run timeline » annotée, et le tableau Timeout opportunities.
- P2 : endpoints lents, Web Vitals.
- Lacune : « Wasted time », dans le titre, n'est jamais défini sur la page.
- Défaut de `performance-trends.png` : la série totale écrase la moyenne et le P90.

**features/resource-leaks.md** (2)
- P1 : onglet Resources (scène `run-resources`).
- P2 : diagramme des portées sur un worker.

**features/cpu-memory-disk.md** (1)
- P1 : pistes CPU, mémoire et pages de la timeline (scène `run-timeline-resources`).

**features/ai-diagnosis.md** (2)
- P1 : `ai-diagnosis.png` annotée, avec la liste numérotée de son contenu.
- Il n'y a pas de `<Needs llm />`.
- La page commence par la fusion sémantique avant d'expliquer comment lancer un diagnostic.
- Le SVG de fusion sémantique n'a ni thème sombre ni l'issue « gardé séparé ».

**features/assistant.md** (6)
- P1 : carte de proposition avant et après Apply (scène `assistant-proposal`).
- P2 : une réponse avec tous les types de blocs.
- Passer `![]()` en `<figure>`.

### Recettes

**recipes/regression-or-flaky.md**
- P1 : remplacer `test-case-detail.png` par `tour-test-history.png`.
- P2 : quatre bandes de statuts, une par ligne du tableau.
- Lacune : la baseline doit d'abord être cherchée dans le même environnement.

**recipes/mass-failure.md**
- P1 : `environment-incident.png` à l'étape 2.
- P2 : page d'un cluster annotée.
- Lacune : pas de lien vers les incidents d'environnement ; la timeline du run montre pourtant la corrélation par worker.

**recipes/flaky-cleanup.md**
- P1 : corriger `flaky-detection.png`.
- Lacune : « Candidates over the API » contredit `flaky-tests`, où ils apparaissent dans l'interface comme « Proposed for quarantine ».

**recipes/faster-suite.md** (2)
- P2 : timeline annotée, et le tableau Timeout opportunities à la place de `performance-trends.png`.
- Raccourcir les textes alternatifs (106 mots).

**recipes/broken-locator.md**
- P2 : `next-step-change.png` à l'étape 1, `vscode-heal.png` à l'étape 2.
- Lacune : la correction rapide « Heal » de l'éditeur n'est pas citée.

### Fonctionnalités : renvoyer une correction

**features/locator-healing.md** (1)
- P1 : corriger le SVG de résolution.
- P2 : panneau annoté, cas « diff rename », sélection au moment de l'échec.
- Les deux SVG n'ont pas de thème sombre. « In-page element probe » prête à confusion avec la fonctionnalité Probes.
- Lacunes : « Pick from snapshot », « Copy fix prompt » et « Copy patch » ne sont documentés nulle part.
- Déplacer « Pause at a breakpoint » vers `editor-breakpoints` (120 mots).

**features/locator-usage.md**
- P2 : scènes `locator-usage-drawer` et `project-locators`.
- Lacunes : pas de `## Related` ; une formulation historique.

**features/preflight.md**
- P2 :
  - sortie après `--fix` ;
  - diagramme du diff jusqu'aux chaînes cassées.
- Lacunes :
  - la version de Playwright requise par l'index des locators ;
  - un hook Git sans husky.

**features/fix-plans.md** (10)
- P2 :
  - arbre de décision du « Next step » (il remplace une phrase de 330 mots) ;
  - boîte à outils « More ways to fix » ;
  - sortie de `fixPlanToMarkdown`.

**features/auto-heal.md**
- P1 : PR de réparation rendue.
- P2 : diff et trailer `Piwi-Heal`, écran des réglages.
- La description est fausse et il n'y a pas de `## Related`.
- Le bug `diff-rename` (§6).

**features/issue-tracking.md** (1)
- P1 : le ticket complet tel qu'il est créé.
- P2 : recapturer la fenêtre de création dans l'état configuré.
- Les captures montrent des états vides ou des avertissements, avec un balisage sans style. `project-integration-binding.png` fait 1 750 px de haut à l'écran.
- Lacune : un exemple JQL.

**features/issue-automation.md**
- P2 : texte des commentaires automatiques, et recapture de l'aperçu avec ses trois groupes.
- Le texte alternatif décrit une ligne « en attente d'un seuil » absente de l'image.

**features/pr-feedback.md** (46)
- P1 : le commentaire complet.
- P2 : la liste des statuts de commit (`piwi/tests`, `gate`, `change-coverage`).
- Lacune : « Two things get posted » oublie les statuts de gate et de couverture des changements.

**features/test-selection.md** (32)
- P2 : recadrer `test-selections.png` après Analyze, et le constructeur de sélection avec son aperçu.

**features/change-impact.md**
- P1 : les trois sorties de `piwi run impact`.
- P2 : diagramme fichier modifié → tests, et avant et après au niveau ligne.
- Lacune : clone superficiel et `fetch-depth: 0`.

**features/ai-steps.md** (2)
- P1 : le fichier d'un AI step versionné.
- P2 : cycle de vie.
- Lacunes :
  - un bloc `export` sans version PowerShell ;
  - deux « not available yet » ;
  - pas de `<Needs llm />`.

### Fonctionnalités : trouver ce que les tests ratent

**features/scenario-gaps.md** (4)
- P2 : le squelette de test copié (`renderScenarioDraft`).
- P3 : une carte des fonctionnalités en plusieurs couleurs.
- Deux oranges presque identiques dans `test-map-graph.svg`.

**features/uncovered-changes.md**
- P2 : statut de commit `change-coverage`.
- Les blocs Markdown montrent d'autres fichiers que la capture.

**features/code-reach.md**
- P1 : une capture de couverture navigateur ; les deux actuelles montrent du C# serveur.
- P2 : diagramme « d'un script à un fichier » (cartes de sources).
- Lacunes :
  - il n'y a pas de `<Needs fixtures />` ;
  - aucun dépannage quand aucun fichier navigateur n'apparaît ;
  - deux noms pour une même option.

**features/css-coverage.md**
- P2 : diagramme de 3 règles et 2 tests.
- Lacunes :
  - pas de `<Needs fixtures />` ;
  - absente de `coverage-cost` ;
  - le prérequis est rangé dans « Limits ».

**features/server-coverage.md**
- P1 : séquence de collecte.
- P2 : point de contrôle sur l'en-tête `X-Piwi-Coverage`.
- Lacunes :
  - pas de `<Needs>` ;
  - le seul exemple de démo est le cas du redémarrage.

**features/combined-coverage.md** (1)
- P1 : sortie de `coverage upload`.
- P2 : diagramme des suites vers les lignes.
- Lacunes :
  - bannière « backend restarted » sur la capture ;
  - conflit d'orange entre les deux écrans ;
  - le prérequis de la suite `e2e`.

**features/coverage-insights.md** (2)
- P2 : chronologie d'un chemin qui dépend de l'ordre des tests.
- P3 : recapturer `quarantine-coverage-loss`.

**features/probes.md**
- P1 : sortie de `piwi probe`, qui sort avec le code 0 même en cas d'échec.
- P2 : la ligne de trou « not noticed », et une tâche CI planifiée.

### Fonctionnalités : tendances et rapports

**features/analytics.md** (46)
- P1 : le tableau de bord Overview (`tour-analytics.png` ou une nouvelle scène recadrée).
- P2 : barre de périmètre annotée, menu d'export d'un graphique.
- Lacune : `analytics-handbacks.png` n'a pas la ligne « Fix attempts ».

**features/dashboards.md**
- P2 : mode TV.
- Les captures sont à l'échelle 0,54, et le menu « Move to band » est absent.
- Lacune : le tableau de bord intégré « Team » est oublié.

**features/quality-reports.md**
- P1 : le rapport et l'e-mail.
- P2 : extrait Markdown, destinataires.
- Lacunes : « two » au lieu de quatre ; pas de `## Related`.

**features/timeline-markers.md**
- P1 : `project-detail.png`, l'infobulle d'un marqueur.
- P2 : le panneau des marqueurs.
- Lacune : un exemple GitHub Actions.

**features/notifications.md** (10)
- P1 : les messages reçus.
- P2 : formulaire Slack, cloche du projet.
- La capture actuelle est illisible (5 px), et ses canaux sont « unverified ».
- Lacunes :
  - le port 465 implique `SECURE` ;
  - aucun dépannage quand rien n'est livré.

### Fonctionnalités : utiliser Piwi depuis ailleurs

**features/mcp.md**
- P1 : diagramme de flux, transcription réelle.
- P2 : page de consentement OAuth, détail d'un outil.
- La capture montre le port 3050 et Opencode.
- Lacunes :
  - pas de section Opencode ;
  - pas de vérification par client ;
  - pas de dépannage (401, `mcp-remote`).

**features/agent-skills.md**
- P1 : boucle de retour des agents.
- P2 : activité d'un cluster, sortie de `skills add`.

**features/desktop.md** (2)
- P1 : premier lancement, « Run locally ».
- P2 : projet depuis un dossier, clients MCP.
- Déplacer « Jobs from your editor » et « Reproducing a flake » (230 mots).

**features/extension.md** (4)
- P2 : recadrer la popup.
- Lacunes :
  - « aria-snapshot copier yet » contredit « Assert a region » ;
  - épingler l'extension après l'installation.
- Déplacer le tableau des permissions.

**features/pick-an-element.md**
- P1 : boucle vidéo.
- P2 : sélection multiple, bloc « context for agent ».
- Lacune : le masquage des adresses n'est pas mentionné.

**features/record-actions.md**
- P1 : la barre d'enregistrement, et le TypeScript produit.
- Découper le paragraphe unique en trois.

**features/lint-overlay.md**
- P3 : le cas du conteneur.

**features/extension-connection.md** (3)
- P1 : séquence de la négociation de connexion.
- P2 : page `/extension/connect` et le code dans les réglages, côte à côte.
- Déplacer environ 380 mots vers une page de référence.

**features/tested-elements.md**
- P2 : onglet « At risk », « Limit to an element ».
- La capture est à l'échelle 0,49, sans le sélecteur This page / All pages.

**features/report-a-bug.md**
- P1 : le panneau « Mark what's wrong » et le rapport terminé.
- P2 : boucle vidéo.
- Lacune : des montants d'exemple incohérents.

**features/replay-a-bug-report.md**
- P1 : boucle vidéo.
- P2 : panneau de reprise à la main, menu Export.
- Lacune : « three » au lieu de quatre.

**features/bug-reports.md** (6)
- P1 : diagramme des états.
- P2 : onglet Spec, aperçu « Send to Piwi ».
- La légende « A report's page. » ne dit rien.

**features/devtools.md**
- P1 : la vue Playwright.
- P2 : console Locators.
- Le texte et l'image montrent deux éléments différents.

**features/mock-requests.md**
- P2 : onglet Network du panneau.

**features/test-functions.md**
- P1 : code avant et après.
- P2 : formulaire de revue.
- La capture montre le badge `scanned`, et les sources ne sont pas expliquées.

### Fonctionnalités : éditeurs

**features/ide-integration.md** (19)
- P1 : le lien « open in IDE » survolé, avec son menu ouvert et annoté.
- P2 : la fenêtre Open in IDE (scène `open-in-ide-settings`), un tableau « votre éditeur → quoi régler ».
- Lacune : aucun dépannage quand rien ne s'ouvre.

**features/editors.md** (0)
- P1 : architecture, page d'entrée, capture annotée « ce que vous devez voir ».
- Déplacer le tableau des commandes (416 mots) vers une page de référence générée depuis `package.json`.
- Lacunes :
  - il manque 4 commandes ;
  - pas de `<Needs>`.

**features/jetbrains.md** (763 mots de marge)
- P1 :
  - `jetbrains-heal.png` ;
  - `jetbrains-failures.png` annotée ;
  - une scène de run en pause (effort L, à partir de `run-worker.mjs`).
- Badge « Trial ».
- Lacunes :
  - Node 20 pour Rider ;
  - IntelliJ Community.

**features/editor-failures.md**
- P1 : `vscode-hover.png` recapturée.
- P2 : « Failures follow your edits » en trois images.
- Lacunes :
  - le libellé Baseline ;
  - les prérequis de chaque correction rapide.

**features/editor-runs.md**
- P2 : la barre d'état et ses états, la notification de fin de run.
- Lacune : commencer par « lancer le test au curseur ».

**features/editor-coverage.md**
- P1 : les marques principales (vert, gris, ambre) ; l'image actuelle ne montre que la plus rare.
- La contradiction ASP.NET Core ou Nitro (§5).

**features/editor-breakpoints.md** (2)
- P1 : l'éditeur et le navigateur côte à côte sur le même arrêt.
- P2 : boucle vidéo du choix d'un locator (L).
- Lacune : les versions minimales du reporter sont dispersées sur trois pages.

**features/editor-run-control.md** (7)
- P1 : les deux images sans page.
- P2 : la barre d'état annotée.
- Le texte de `run-control.svg` s'affiche autour de 8 px.
- Les termes « editor service », « run channel » et « stop » sont employés avant leur diagramme.

**features/editor-stop-code.md** (2)
- P2 : recadrage, code avant et après « Assert », arrêt sur échec.

**features/editor-recording.md**
- P1 : boucle vidéo (L) ou image fixe (M).
- Déplacer « Send from Piwi Picker » (314 mots) vers sa propre page.
- Les prérequis sont rangés en bas de page.

**features/recorded-code.md**
- P1 : code avant et après, produit par `piwi codegen`.
- Lacunes :
  - où définir les valeurs `E2E_*` ;
  - `defineConfig` contre `wrapConfig`.

**features/editor-connection.md**
- P1 : les trois états de la barre d'état, l'échelle des sources, le tableau des messages réels.
- Lacunes :
  - pas de `## Related` ;
  - une phrase orpheline.

### Hébergement

**operate/deployment.md**
- P1 : topologie.
- P2 : vérification par `/api/health`.
- Le manifeste Kubernetes à corriger, et une colonne fictive (§5).

**operate/one-click-deploy.md**
- Les boutons Render et Koyeb sont chargés depuis un site tiers.
- La contradiction sur Railway.
- Pas de vérification ; `openssl` au lieu de `node -e`.

**operate/production-checklist.md**
- P2 : topologie numérotée, Settings → About.
- Lacunes :
  - jeton de setup, `PIWI_SITE_URL`, SMTP ;
  - la liste des accès sortants ;
  - une vérification finale.

**operate/authentication.md** (4)
- P1 : premier administrateur et connexion.
- P2 :
  - tableau des champs de l'application OAuth ;
  - arbre de liaison des comptes.
- Séparer OAuth dans sa propre page.
- Lacunes : SMTP, récupération du compte, invitations, limites (§5).

**operate/project-access.md** (18)
- P2 : diagramme « les droits s'additionnent », rôles d'un utilisateur.
- La grille est à l'échelle 1 avec un balisage sans style.

**operate/api-keys.md**
- P1 : gestion des clés (`user-api-keys`).
- Lacunes :
  - les variables d'environnement ;
  - 401 ou 403 ;
  - rotation d'une clé.

**operate/storage.md** (0)
- P2 : Storage analysis.
- Lacunes :
  - migration du disque local vers S3 ;
  - vérification de S3 ;
  - versionnage du bucket ;
  - fuseau UTC.

**operate/database.md**
- P2 : matrice SQLite ou PostgreSQL × disque local ou S3.
- Lacunes :
  - SQLite sur un système de fichiers réseau ;
  - `sslmode` ;
  - croissance de la base.

**operate/backup-restore.md**
- P2 : arborescence de `.data/`.
- Lacune P1 : `PIWI_SECRET_KEY`.
- `sqlite3` est absent de l'image.

**operate/upgrading.md** (10)
- P1 : flux de mise à jour et de retour arrière.
- P2 : les vrais logs de migration, `/api/version`.

**operate/metrics.md**
- P1 : sortie OpenMetrics.
- Lacunes :
  - `scheme: https` ;
  - lien vers `reference/metrics` ;
  - exemple PromQL.

**operate/tracing.md**
- P2 : cascade de spans.
- Lacunes :
  - pas de `## Related` ;
  - `OTEL_*` absentes du registre ;
  - échantillonnage ;
  - pas de gRPC.

**operate/capabilities.md**
- P1 : page Setup (`setup-ladder-declined`).
- Contradiction sur le droit de décliner une capacité.

**operate/localization.md**
- P3 : capture des réglages.
- Lacune : les rapports planifiés tournent en UTC par défaut.

**operate/integrations.md** (17)
- P2 : sens des flux réseau avec Jira.
- `integrations-settings.png` montre l'état vide.
- Contradiction Cloud ou auto-hébergé.

### Référence

**reference/cli.md**
- P2 : un bloc de sortie par commande, testé.
- Lacunes :
  - `coverage` absent du tableau ;
  - « four » au lieu de six ;
  - les statuts d'`init` ;
  - les codes de sortie de `probe`, `init` et `skills`.

**reference/clues.md**
- P2 : « Most likely » et « All clues » annotés.
- Lacune : les identifiants des scénarios d'échec.

**reference/gap-detectors.md**
- P1 : identifiants des détecteurs, confiance de chacun.
- P2 : ligne annotée, calcul du score détaillé.

**reference/notification-events.md**
- P1 : signature, nouvelles tentatives, déduplication.
- P2 : un exemple de contenu par événement, diagramme « ce qu'envoie un run terminé ».

**reference/steps-format.md**
- P2 : `steps.json` et le spec produit, côte à côte.
- Lacunes :
  - pas de `## Related` ;
  - l'unité de `timestamp`.

**reference/test-metadata.md**
- P2 : « où chaque champ apparaît », annoté ; matrice origine × usage générée depuis `RUN_USES`.
- Les noms de tables SQL sont exposés aux utilisateurs.

**reference/test-search.md**
- P2 : complétion (scène `test-search`).
- Lacunes :
  - `-flaky` n'est pas un filtre de statut ;
  - `project:` désigne le projet Playwright.

**reference/locator-stability.md**
- P2 : onglet « At risk ».
- Page générable depuis `LOCATOR_STABILITY_RULES`.

**reference/bug-report-file.md**
- P2 : un fichier `.piwibug` d'exemple à télécharger.

**reference/keyboard-shortcuts.md**
- P3 : `<kbd>` et une feuille de style d'impression.
- Lacune : les raccourcis des éditeurs sont absents.

**reference/coverage-cost.md**
- P3 : graphique de surcoût.
- Lacunes : CSS, date et version des mesures, `## Related`.

**reference/analytics-widgets.md** (générée)
- P2 : une planche de miniatures par bande ; le script de captures peut la produire.
- Ajouter les colonnes Options et taille.

**reference/reporter-options.md** (générée)
- P2 : un exemple `wrapConfig` en tête.
- Compléter le JSDoc de `ciInfo`, `tags`, `customData`, `label` et `relatedIssue`.

**reference/metrics.md** (générée)
- Lacunes : dimensions de ventilation, nom OpenMetrics, « wait steps » non défini.

**reference/mcp-tools.md** (générée)
- Lacune : la colonne des paramètres.

**reference/features.md, reference/whats-new.md** (générées)
- Corriger le `where` de l'assistant.
- Les entrées de `whats-new` sont des sujets de commit bruts.

**blog/** : rien.
