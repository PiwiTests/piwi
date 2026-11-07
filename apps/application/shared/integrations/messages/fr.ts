/**
 * French copy — sentence case, proper accents. Mirrors `en.ts` key for key; the
 * `Record<MessageKey, …>` annotation makes a missing or extra key a type error,
 * and a runtime parity test guards it too. French treats 0 and 1 as singular,
 * which `Intl.PluralRules('fr')` already encodes.
 */
import type { MessageKey, MessageValue } from './en';

export const fr: Record<MessageKey, MessageValue> = {
  // En-têtes de section
  'section.whatHappened': "Ce qui s'est passé",
  'section.mostLikely': 'Le plus probable',
  'section.evidence': 'Preuves',
  'section.whatToDo': 'Quoi faire',
  'section.links': 'Liens',
  'section.affectedTests': { one: '{count} test affecté', other: '{count} tests affectés' },

  // Étiquettes de faits
  'fact.errorType': "Type d'erreur",
  'fact.firstSeen': 'Première occurrence',
  'fact.lastSeen': 'Dernière occurrence',
  'fact.occurrences': 'Occurrences',
  'fact.branches': { one: 'Branche', other: 'Branches' },
  'fact.environments': { one: 'Environnement', other: 'Environnements' },
  'fact.commit': 'Dernier commit',
  'value.inRuns': { one: '{occurrences} sur {count} série', other: '{occurrences} sur {count} séries' },

  // En-têtes du tableau des tests affectés
  'table.test': 'Test',
  'table.file': 'Fichier',
  'table.owner': 'Propriétaire',
  'table.failures': 'Échecs',
  'text.moreTests': { one: '… et {count} autre test.', other: '… et {count} autres tests.' },
  'text.moreClusters': { one: "… et {count} autre grappe d'échecs.", other: "… et {count} autres grappes d'échecs." },

  // Étiquettes en ligne
  'label.rootCause': 'Cause racine',
  'label.failingLocator': 'Localisateur en échec',
  'label.verify': 'Vérifier',
  'label.reproduce': 'Reproduire',
  'label.category': 'Catégorie',

  // Catégories et confiance du diagnostic
  'category.app-bug': 'Bug applicatif',
  'category.test-bug': 'Bug du test',
  'category.flaky-test': 'Test instable',
  'category.infrastructure': 'Infrastructure',
  'category.environment': 'Environnement',
  'confidence.high': 'confiance élevée',
  'confidence.medium': 'confiance moyenne',
  'confidence.low': 'confiance faible',

  // Tickets liés
  'section.related': 'Tickets liés',
  'related.fixedBefore': 'un échec du même type, déjà corrigé',

  // Un ticket créé par une règle, sans intervention humaine
  'count.occurrences': { one: '{count} occurrence', other: '{count} occurrences' },
  'count.runs': { one: '{count} série', other: '{count} séries' },
  'auto.filed': 'Créé automatiquement par Piwi après {occurrences} sur {runs} depuis le {since}.',
  'auto.filed.noDate': 'Créé automatiquement par Piwi après {occurrences} sur {runs}.',
  'auto.countedOn': 'Comptés sur {where}.',
  'auto.countedIn': {
    one: 'Comptés dans l’environnement {where}.',
    other: 'Comptés dans les environnements {where}.',
  },

  // Étiquettes de liens
  'link.cluster': "Grappe d'échecs",
  'link.execution': 'Dernière exécution',
  'link.run': 'Série de tests',
  'link.share': 'Rapport partageable',
  'link.dashboard': 'Ouvrir dans Piwi',
  'link.bugReport': 'Rapport de bug dans Piwi',

  // Rapports de bug (un ticket créé depuis un rapport envoyé par Piwi Picker)
  'section.stepsToReproduce': 'Étapes pour reproduire',
  'section.expectedActual': 'Attendu et constaté',
  'section.failingTest': 'Le test en échec',
  'section.reproductions': 'Reproductions',
  'section.missedBy': 'Pourquoi la suite ne l’a pas vu',
  'label.expected': 'Attendu',
  'label.actual': 'La page affichait',
  'label.note': 'Note',
  'fact.page': 'Page',
  'fact.browser': 'Navigateur',
  'fact.reportedBy': 'Signalé par',
  'fact.reportedOn': 'Signalé le',
  'evidence.screenshots': {
    one: '{count} capture d’écran, jointe à ce ticket',
    other: '{count} captures d’écran, jointes à ce ticket',
  },
  'evidence.console': {
    one: '{count} erreur ou avertissement de la console',
    other: '{count} erreurs et avertissements de la console',
  },
  'evidence.requests': { one: '{count} requête en échec', other: '{count} requêtes en échec' },
  'text.reportLanguage':
    'Signalé en {language}. Les étapes sont réécrites dans la langue de ce ticket ; le titre, la note et les valeurs saisies par la personne qui a signalé restent telles qu’elles ont été écrites.',
  'text.failingTest':
    'À committer sous {path}. Marqué test.fail(), il garde la suite au vert tant que le bug existe ; quand il passe, le bug semble corrigé.',
  'verdict.reproduced': 'Reproduit',
  'verdict.notReproduced': 'Non reproduit',
  'verdict.diverged': 'Bug non atteint (étape {step})',
  'reproduction.replay': 'rejoué dans un navigateur',
  'reproduction.desktop': 'exécuté avec Playwright',
  'comment.bugLooksFixed':
    'Le test de ce bug est passé dans la série #{run} alors qu’il est encore marqué test.fail() : le bug semble corrigé. Retirez test.fail() avec le correctif.',

  // Commentaires de politique (réécrits dans le ticket, dans sa langue)
  'comment.fixLanded':
    'Correctif appliqué dans la série #{run} (commit {commit}, {verification}) — tous les tests affectés sont passés.',
  'comment.fixLanded.noCommit':
    'Correctif appliqué dans la série #{run} ({verification}) — tous les tests affectés sont passés.',
  'verification.diagnosisVerified': 'diagnostic vérifié',
  'verification.stoppedFailing': 'a cessé d’échouer',
  'comment.regressed': 'Régression dans la série #{run} — le correctif n’a pas tenu.',
  'comment.stillFailing': {
    one: 'Toujours en échec — +{count} occurrence sur {runs} depuis la dernière note, dernière série #{latest}.',
    other: 'Toujours en échec — +{count} occurrences sur {runs} depuis la dernière note, dernière série #{latest}.',
  },
  'comment.lastFailureOn': 'Dernier échec sur {where}.',
  'comment.lastFailureIn': 'Dernier échec dans l’environnement {where}.',
  'comment.newTests': {
    one: 'Échoue désormais aussi dans {count} autre test :',
    other: 'Échoue désormais aussi dans {count} autres tests :',
  },
  'comment.newBranches': {
    one: 'Échoue désormais sur une nouvelle branche : {list}.',
    other: 'Échoue désormais sur de nouvelles branches : {list}.',
  },
  'comment.newEnvironments': {
    one: 'Échoue désormais dans un nouvel environnement : {list}.',
    other: 'Échoue désormais dans de nouveaux environnements : {list}.',
  },
  'comment.diagnosis': 'Diagnostic de Piwi :',
  'comment.mergedInto': 'Cet échec a été fusionné dans {key} — le suivi se poursuit là-bas.',
  'comment.absorbed': '{key} a été absorbé dans ce ticket — ses échecs sont suivis ici désormais.',
  // Un ticket créé par une personne, avec son commentaire, pour une série ou une exécution
  'section.comment': 'Commentaire',
  'section.commentFrom': 'Commentaire de {name}',
  'section.theRun': 'La série',
  'section.tests': { one: '{count} test', other: '{count} tests' },
  'section.failureClusters': { one: "{count} grappe d'échecs", other: "{count} grappes d'échecs" },
  'fact.project': 'Projet',
  'fact.branch': 'Branche',
  'fact.commit.run': 'Commit',
  'fact.environment': 'Environnement',
  'fact.startedAt': 'Démarré',
  'fact.results': 'Résultats',
  'value.runResults': '{passed} réussis, {failed} en échec, {flaky} instables, {skipped} ignorés, sur {total}',
  'table.project': 'Projet',
  'table.result': 'Résultat',
  'result.passed': 'Réussi',
  'result.failed': 'En échec',
  'result.timedOut': 'Délai dépassé',
  'result.flaky': 'Instable',
  'result.skipped': 'Ignoré',
  'result.interrupted': 'Interrompu',
  'result.didNotRun': 'Non exécuté',
  'link.thisExecution': 'Cette exécution',
  'text.filedBy': 'Créé par {name} depuis Piwi.',
  'text.filedFromPiwi': 'Créé depuis Piwi.',
  'title.run': 'Série #{id}',
  'title.failedOf': '{failed} sur {total} en échec',
  'title.onBranch': 'sur {branch}',
  'comment.addedFrom': 'Commentaire ajouté depuis Piwi sur {where}.',
};
