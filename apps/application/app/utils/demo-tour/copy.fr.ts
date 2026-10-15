import type { TourCopy } from './copy';

/**
 * The guided tour in French, with exactly the keys of the English (`copy.en.ts`).
 * A `**bold**` dashboard label stays in English, as the screen spells it. The
 * reader is « vous »; a no-break space goes before a colon and inside « », a
 * narrow one before ? ; and !.
 */
export const FR_COPY = {
  ui: {
    launch: 'Visite guidée',
    launchTitle: 'Choisissez votre rôle et découvrez les écrans que vous utiliseriez le plus',
    promptTitle: 'Envie d’une visite guidée ?',
    promptBody:
      'Choisissez votre rôle : la visite vous montre les écrans que vous utiliseriez le plus, sur les données d’exemple de cette démo.',
    roles: 'Votre rôle',
    stopCount: '{count} étapes',
    later: 'Plus tard',
    dismiss: 'Ne plus afficher',
    language: 'Langue',
    next: 'Suivant',
    back: 'Précédent',
    done: 'Terminer',
    progress: '{{current}} sur {{total}}',
    close: 'Quitter la visite',
    docs: 'Documentation (en anglais)',
    finishedTitle: 'Fin de la visite',
    finishedBody: 'Les visites des autres rôles sont dans « Visite guidée », dans le bandeau.',
  },
  profiles: {
    developer: {
      label: 'Développement',
      hint: 'Comprendre un échec, le corriger',
      stops: {
        failure: {
          title: 'Un échec, lu de haut en bas',
          body: 'Chaque exécution en échec s’ouvre sur ce bloc. Le titre dit ce qui a échoué, **Most likely** donne la cause que désignent les preuves, et **Next** la seule étape à suivre : ici, appliquer le patch écrit par le diagnostic IA du groupe d’échecs.',
        },
        evidence: {
          title: 'Les preuves, conservées après la CI',
          body: 'Ce que le run a capturé pour cette exécution, un onglet par vue : les étapes, les requêtes et la console sur une même chronologie, la page au moment de l’échec, le code source du test. Un point marque chaque onglet que cite **Most likely**.',
        },
        locator: {
          title: 'Le locator que vous auriez dû utiliser',
          body: "Quand un locator casse, comme ici getByRole('button') qui trouvait trois boutons, Piwi classe des remplaçants capturés lors du dernier run où le test passait. Copiez celui qu’il recommande, ou cliquez sur l’élément de la page en échec avec **Pick from snapshot**.",
        },
        diagnosis: {
          title: 'Un diagnostic IA, vérifié sur votre code',
          body: 'Avec un fournisseur d’IA configuré, Piwi diagnostique un groupe d’échecs à partir de ses preuves et des commits depuis son dernier succès. Celui-ci relie les 51 lignes du tableau des utilisateurs à la taille de page par défaut de l’API et propose ce patch, marqué **Applies cleanly** sur le code. Un correctif a depuis été livré, et il tient.',
        },
        coverage: {
          title: 'Les lignes serveur que ce test a exécutées',
          body: 'Quand un projet enregistre la couverture, l’onglet **Source** liste le code qu’un test a exécuté. Ce test en échec a exécuté cinq fichiers de l’API ASP.NET Core, les endpoints des utilisateurs en tête avec les lignes suspectes ; ouvrez-en un pour lire ses lignes exécutées. Le lien **tests** d’un fichier ouvre tous les tests qui l’exécutent, ligne par ligne.',
        },
        mcp: {
          title: 'Interrogez Piwi depuis votre éditeur',
          body: 'Piwi est aussi un serveur MCP : Claude Code, Cursor ou Copilot dans VS Code peuvent lire les groupes d’échecs, leurs preuves et leurs plans de correction, et les trier sans quitter l’éditeur. **Client setup** donne la configuration de chaque client ; l’endpoint de cette démo n’est pas actif.',
        },
        simulate: {
          title: 'Regardez un run arriver',
          body: '**Simulate a test run** envoie un nouveau run dans la démo, comme le reporter le fait depuis la CI. Avec **Run with failures**, deux dépassements de délai rejoignent le groupe du premier échec que vous avez vu, et une nouvelle erreur ouvre son propre groupe.',
        },
      },
    },
    qa: {
      label: 'QA / tests',
      hint: 'Tests instables, lents, manquants',
      stops: {
        inbox: {
          title: 'Les échecs, groupés par cause',
          body: 'La **Failure inbox** liste tous les groupes d’échecs ouverts des projets : une ligne par cause racine, quel que soit le nombre de tests touchés. Résolvez, assignez, reportez ou mettez en quarantaine une ligne au clavier, et la décision vaut pour tous ses tests.',
        },
        flaky: {
          title: 'Les tests instables, classés par coût',
          body: 'Les tests qui échouent puis passent, classés selon le temps de CI que gaspillent leurs nouvelles tentatives, chacun avec un score de 0 à 100 tiré de ses tentatives et de ses bascules, et son principal suspect. **Quarantine** garde un test actif, avec ses résultats, mais le contrôle de la CI l’ignore.',
        },
        suspects: {
          title: 'Ce qui le rend instable',
          body: 'Piwi compare les exécutions en échec et réussies de ce test sur 30 jours, et classe ce qui distingue les échecs. Une API de panier lente arrive en tête, et la ralentir dans le Flake Lab a reproduit l’échec 3 fois sur 4.',
        },
        slow: {
          title: 'Les tests qui ralentissent la suite',
          body: '**Slowest tests** classe les tests du projet par durée moyenne sur les derniers runs, avec leur pire et leur dernier temps. Les tests de paiement par carte et par PayPal y sont marqués plus lents : leurs derniers runs atteignent le délai de 30 s.',
        },
        lab: {
          title: 'Prouver un correctif avant de lever la quarantaine',
          body: 'Le Flake Lab relance un test instable sous chaque condition suspecte, à côté d’un témoin, puis de nouveau après le correctif. « Table pagination works correctly » est **Verified fixed** : sous le ralentissement qui le reproduisait, le correctif a tenu 5 fois sur 5, et la levée de sa quarantaine est proposée.',
        },
        gaps: {
          title: 'Ce que vos tests ne couvrent pas',
          body: 'La Test Map dessine les fonctionnalités de l’application à partir de ce que les tests atteignent, puis liste les tests qui n’existent pas encore, classés par exposition. En voici un : les tests passent toujours quand POST /api/orders casse.',
        },
      },
    },
    product: {
      label: 'Product owner',
      hint: 'La qualité au fil du temps, les rapports',
      stops: {
        health: {
          title: 'Tous les projets d’un coup d’œil',
          body: '**Project health** montre pour chaque projet ses 20 derniers runs, sa tendance et le taux de réussite de son dernier run, les projets en échec en premier. Ouvrez-en un pour voir ce qui a échoué.',
        },
        analytics: {
          title: 'La qualité au fil du temps',
          body: 'Les **Headline numbers** de tous les projets sur les 30 derniers jours, comparés aux 30 précédents : taux de réussite, tests instables, minutes de CI gaspillées, causes d’échec ouvertes, délai de correction. Quand un projet fixe un objectif, la tuile indique combien de projets l’atteignent.',
        },
        dashboards: {
          title: 'Un tableau de bord par équipe',
          body: 'En plus des tableaux de bord intégrés, une équipe garde ses propres widgets et son périmètre : **Checkout team** suit les smoke tests du checkout, sprint après sprint. Tout tableau de bord peut passer sur un écran mural en mode TV ou partir en rapport planifié.',
        },
        reports: {
          title: 'Des rapports qui partent tout seuls',
          body: 'Une planification envoie un rapport qualité à ses canaux chaque jour, semaine ou mois, en anglais ou en français, et conserve chacun ici comme instantané. **Weekly engineering report** en est une ; dans cette démo, rien n’est envoyé.',
        },
        issue: {
          title: 'Des échecs aux tickets',
          body: 'Cet échec de connexion est suivi dans DEMO-42, créé depuis Piwi avec le plan de correction du groupe d’échecs comme description, et désormais « In Progress ». Sa clé et son statut suivent l’échec : sur cette page, sur ses exécutions et dans la boîte de réception. Un groupe sans ticket propose **Create issue** et **Link an issue**.',
        },
        personas: {
          title: 'Voyez-le comme votre équipe',
          body: '**Acting as** recharge la démo au nom de l’une des sept personnes de l’exemple, d’un compte administrateur à une partie prenante qui ne peut que consulter E2E Checkout. Chacune voit ce que son rôle permet.',
        },
      },
    },
    platform: {
      label: 'DevOps / plateforme',
      hint: 'Vitesse de la CI, santé des machines',
      stops: {
        timeline: {
          title: 'Où est passé le temps du run',
          body: 'Les tests de chaque worker sur une même chronologie, avec le CPU, la mémoire et les pages ouvertes de la machine qui les a exécutés. Ce run a été réparti sur deux shards de CI : la machine de chaque shard a ses propres courbes, au-dessus de ses deux workers.',
        },
        leaks: {
          title: 'Les fuites entre les tests',
          body: '**Findings** liste ce que les tests ont laissé ouvert au-delà de leur portée, avec la ligne qui l’a ouvert. Ici, la fixture loggedInContext laisse un contexte de navigateur ouvert dans les 10 tests, jusqu’à l’arrêt du worker.',
        },
        incident: {
          title: 'Quand c’est le staging qui tombe, pas les tests',
          body: 'Dix tests sur onze ont échoué en se connectant au staging, donc Piwi a marqué le run comme incident d’environnement. Les scores d’instabilité, les références, la vérification des correctifs et le contrôle de la CI l’ignorent, et les graphiques de tendance reçoivent un seul repère.',
        },
        alerts: {
          title: 'Des alertes là où vous travaillez',
          body: 'Un canal est la destination des alertes : un e-mail, un webhook Slack ou Microsoft Teams, ou votre propre webhook. Un abonnement choisit ensuite les projets et les événements, comme un run en échec, un nouveau groupe d’échecs ou un incident d’environnement.',
        },
        setup: {
          title: 'Ce qui est activé',
          body: "**What's switched on** lit les données de cette instance, et non sa configuration, pour montrer les fonctionnalités en service et ce qu’il faut à chacune des autres, comme un jeton de dépôt ou un fournisseur d’IA. Les étapes au-dessus connectent une suite.",
        },
        simulate: {
          title: 'Regardez un run arriver en direct',
          body: '**Simulate a test run** envoie un nouveau run dans la démo, comme le reporter le fait depuis la CI. **Leaky run** rejoue la fuite que vous venez de voir : une fixture de connexion laisse un contexte de navigateur ouvert à chaque test.',
        },
      },
    },
  },
} satisfies TourCopy;
